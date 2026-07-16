import {
  Config,
  Context,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  PubSub,
  Random,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  BridgeConfigurationError,
  GatewayError,
  GatewayIdempotencyConflictError,
  HttpRequestError,
  IlinkProtocolError,
  IlinkSessionExpiredError,
  QrCodeError,
  StateStoreError,
} from "./errors.ts";
import { DEFAULT_PI_WEB_BASE_URL, makePiGateway, type PiGateway } from "./gateway.ts";
import { makeJsonHttpClient } from "./http.ts";
import { makeIlinkClient, type LoginCallbacks, type WeixinTransport } from "./ilink.ts";
import { IlinkMessageSchema, type IlinkImage, type UpdatesResponse } from "./ilink-protocol.ts";
import {
  messageIdentity,
  parseInboundMessage,
  progressClientId,
  renderInboundPrompt,
  replyClientId,
  splitTextReply,
} from "./message.ts";
import { type PendingImageBatch, type SessionBinding, type WeixinAuth } from "./schema.ts";
import { makeStateStore, type StateStore } from "./state.ts";

const UNSUPPORTED_MESSAGE_REPLY = "当前 pi-weixin 仅支持文本和图片消息。";
const VOICE_TRANSCRIPTION_UNAVAILABLE_REPLY =
  "微信暂时没能识别这条语音，请重新发送语音，或直接发送文字。";
const MEDIA_ERROR_REPLY = "图片下载或解密失败，请重新发送原图。";
const IDEMPOTENCY_CONFLICT_REPLY =
  "上一条请求的执行状态无法安全确认。为避免重复执行，已停止自动重试；请检查 Pi 会话后重新发送。";
export const IMAGE_BATCH_WAIT_MILLIS = 30_000;

export const imageAwarePollTimeout = (
  serverTimeoutMs: number,
  pending: PendingImageBatch | undefined,
  now: number,
): number =>
  pending?._tag === "Collecting"
    ? Math.max(1, Math.min(serverTimeoutMs, pending.deadlineAt - now))
    : serverTimeoutMs;

export interface BridgeStatus {
  readonly running: boolean;
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly accountId?: string;
  readonly sessionId?: string;
  readonly lastError?: string;
  readonly connection: BridgeConnectionState;
}

export type BridgeConnectionState =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Connected" }
  | { readonly _tag: "Retrying"; readonly attempt: number }
  | { readonly _tag: "ReauthenticationRequired" };

export interface BatchDependencies {
  readonly store: StateStore;
  readonly transport: WeixinTransport;
  readonly gateway: PiGateway;
}

type BatchError =
  | StateStoreError
  | HttpRequestError
  | IlinkProtocolError
  | IlinkSessionExpiredError
  | GatewayError
  | GatewayIdempotencyConflictError;

type PromptDispatch = Readonly<{
  sessionId: string;
  userId: string;
  requestId: string;
  prompt: string;
  images: ReadonlyArray<IlinkImage>;
  contextToken: string;
}>;

const dispatchPrompt = (
  input: PromptDispatch,
  auth: WeixinAuth,
  transport: WeixinTransport,
  gateway: PiGateway,
): Effect.Effect<void, BatchError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.forEach(input.images, transport.downloadImage, {
      concurrency: 2,
    }).pipe(
      Effect.map((images) => ({ _tag: "Ready" as const, images })),
      Effect.catchTag("IlinkMediaError", () => Effect.succeed({ _tag: "Rejected" as const })),
    );
    if (prepared._tag === "Rejected") {
      yield* transport.sendText(
        auth,
        input.userId,
        MEDIA_ERROR_REPLY,
        input.contextToken,
        replyClientId(input.requestId, 0),
      );
      return;
    }

    const typing = yield* transport.startTyping(auth, input.userId, input.contextToken).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error._tag === "IlinkSessionExpiredError"
          ? Effect.fail(error)
          : Effect.logWarning("微信输入状态启动失败", { error: error._tag }).pipe(
              Effect.as(Option.none()),
            ),
      ),
    );
    const stopTyping: Effect.Effect<void, IlinkSessionExpiredError> = Option.isNone(typing)
      ? Effect.void
      : transport
          .stopTyping(auth, typing.value)
          .pipe(
            Effect.catch((error) =>
              error._tag === "IlinkSessionExpiredError"
                ? Effect.fail(error)
                : Effect.logWarning("微信输入状态停止失败", { error: error._tag }),
            ),
          );
    const reply = yield* gateway
      .promptAndWait(input.sessionId, input.requestId, input.prompt, prepared.images, (event) =>
        transport.sendText(
          auth,
          input.userId,
          `Pi 正在使用工具：${event.toolName}`,
          input.contextToken,
          progressClientId(input.requestId, event.toolCallId),
        ),
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (error) => stopTyping.pipe(Effect.andThen(Effect.fail(error))),
          onSuccess: (value) => stopTyping.pipe(Effect.as(value)),
        }),
        Effect.catchTag("GatewayIdempotencyConflictError", () =>
          Effect.succeed(IDEMPOTENCY_CONFLICT_REPLY),
        ),
      );
    yield* Effect.forEach(
      splitTextReply(reply),
      (chunk, chunkIndex) =>
        transport.sendText(
          auth,
          input.userId,
          chunk,
          input.contextToken,
          replyClientId(input.requestId, chunkIndex),
        ),
      { concurrency: 1, discard: true },
    );
  });

const dispatchPending = (
  pending: Extract<PendingImageBatch, { readonly _tag: "Dispatching" }>,
  auth: WeixinAuth,
  dependencies: BatchDependencies,
) =>
  dispatchPrompt(
    {
      sessionId: pending.sessionId,
      userId: pending.userId,
      requestId: pending.requestId,
      prompt: pending.prompt,
      images: pending.images,
      contextToken: pending.contextToken,
    },
    auth,
    dependencies.transport,
    dependencies.gateway,
  ).pipe(
    Effect.andThen(
      dependencies.store.transitionInbound({
        _tag: "CompleteImages",
        requestId: pending.requestId,
      }),
    ),
    Effect.asVoid,
  );

export const processUpdateBatch = (
  response: UpdatesResponse,
  dependencies: BatchDependencies,
): Effect.Effect<void, BatchError> =>
  Effect.gen(function* () {
    const { store, transport, gateway } = dependencies;
    const initial = yield* store.read;
    if (!initial.auth || !initial.binding) {
      return yield* new IlinkProtocolError({
        operation: "bridge.process_batch",
        cause: "微信账号或 Pi session 尚未绑定",
      });
    }
    const auth = initial.auth;
    const binding = initial.binding;

    let ready = initial;
    if ((response.msgs?.length ?? 0) === 0) {
      ready = yield* store.transitionInbound({
        _tag: "ExpireImages",
        now: yield* Clock.currentTimeMillis,
      });
    }
    if (
      ready.pendingImageBatch?._tag === "Collecting" &&
      (ready.pendingImageBatch.sessionId !== binding.sessionId ||
        ready.pendingImageBatch.userId !== auth.userId)
    ) {
      ready = yield* store.transitionInbound({ _tag: "FlushImages" });
    }
    if (ready.pendingImageBatch?._tag === "Dispatching") {
      yield* dispatchPending(ready.pendingImageBatch, auth, dependencies);
    }

    yield* Effect.forEach(
      response.msgs ?? [],
      (rawMessage) =>
        Effect.gen(function* () {
          const id = messageIdentity(rawMessage);
          const current = yield* store.read;
          if (current.processedMessageIds.includes(id)) return;

          const decoded = yield* Schema.decodeUnknownEffect(IlinkMessageSchema)(rawMessage).pipe(
            Effect.option,
          );
          if (Option.isNone(decoded)) {
            yield* store.markProcessed(id);
            return;
          }
          const message = decoded.value;
          const fromUserId = message.from_user_id;
          if (message.message_type !== 1 || fromUserId !== auth.userId) {
            yield* store.markProcessed(id);
            return;
          }

          const inbound = parseInboundMessage(message);
          const text = renderInboundPrompt(inbound);
          const imageParts = inbound.parts.filter((part) => part._tag === "Image");
          if (imageParts.some((part) => part.image === undefined)) {
            yield* transport.sendText(
              auth,
              fromUserId,
              MEDIA_ERROR_REPLY,
              message.context_token ?? "",
              replyClientId(id, 0),
            );
            yield* store.markProcessed(id);
            return;
          }
          const images = imageParts.flatMap((part) => (part.image ? [part.image] : []));
          if (images.length > 0 && text === undefined) {
            const now = yield* Clock.currentTimeMillis;
            const collected = yield* store.transitionInbound({
              _tag: "CollectImages",
              sessionId: binding.sessionId,
              userId: fromUserId,
              messageId: id,
              images,
              contextToken: message.context_token ?? "",
              deadlineAt: now + IMAGE_BATCH_WAIT_MILLIS,
            });
            if (!collected.processedMessageIds.includes(id)) {
              return yield* new IlinkProtocolError({
                operation: "bridge.collect_images",
                cause: "pending image batch has a different owner",
              });
            }
            return;
          }

          const pending = (yield* store.read).pendingImageBatch;
          if (text !== undefined && (images.length > 0 || pending?._tag === "Collecting")) {
            const state = yield* store.transitionInbound({
              _tag: "DispatchImages",
              sessionId: binding.sessionId,
              userId: fromUserId,
              messageId: id,
              images,
              contextToken: message.context_token ?? "",
              prompt: text,
            });
            if (state.pendingImageBatch?._tag === "Dispatching") {
              yield* dispatchPending(state.pendingImageBatch, auth, dependencies);
            }
            return;
          }

          const prompt = text;
          const fallbackReply = inbound.parts.some((part) => part._tag === "Voice")
            ? VOICE_TRANSCRIPTION_UNAVAILABLE_REPLY
            : UNSUPPORTED_MESSAGE_REPLY;
          if (prompt) {
            yield* dispatchPrompt(
              {
                sessionId: binding.sessionId,
                userId: fromUserId,
                requestId: id,
                prompt,
                images: [],
                contextToken: message.context_token ?? "",
              },
              auth,
              transport,
              gateway,
            );
          } else {
            yield* transport.sendText(
              auth,
              fromUserId,
              fallbackReply,
              message.context_token ?? "",
              replyClientId(id, 0),
            );
          }
          yield* store.markProcessed(id);
        }),
      { concurrency: 1, discard: true },
    );

    const expired = yield* store.transitionInbound({
      _tag: "ExpireImages",
      now: yield* Clock.currentTimeMillis,
    });
    if (expired.pendingImageBatch?._tag === "Dispatching") {
      yield* dispatchPending(expired.pendingImageBatch, auth, dependencies);
    }

    if (response.get_updates_buf !== undefined) yield* store.saveCursor(response.get_updates_buf);
  }).pipe(Effect.withSpan("pi_weixin.batch.process"));

type LoginError =
  | QrCodeError
  | BridgeConfigurationError
  | StateStoreError
  | HttpRequestError
  | IlinkProtocolError
  | IlinkSessionExpiredError;
type BridgeLoopError = BatchError;

export interface BridgeService {
  readonly status: Effect.Effect<BridgeStatus, StateStoreError>;
  readonly statusChanges: Stream.Stream<Exit.Exit<BridgeStatus, StateStoreError>>;
  readonly start: Effect.Effect<boolean, StateStoreError>;
  readonly stop: Effect.Effect<void>;
  readonly cancelLogin: Effect.Effect<void>;
  readonly loginAndBind: (
    callbacks: LoginCallbacks<QrCodeError | BridgeConfigurationError>,
    binding: SessionBinding,
  ) => Effect.Effect<WeixinAuth, LoginError>;
  readonly bind: (binding: SessionBinding) => Effect.Effect<void, StateStoreError>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void, StateStoreError>;
  readonly logout: Effect.Effect<void, StateStoreError>;
}

export class Bridge extends Context.Service<Bridge, BridgeService>()("pi-weixin/Bridge") {}

const describeError = (error: BridgeLoopError): string => error._tag;

export const BridgeLive = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const home = yield* Config.string("HOME").pipe(
      Effect.mapError(() => new BridgeConfigurationError({ reason: "HOME is not configured" })),
    );
    const statePath = yield* Config.string("PI_WEIXIN_STATE_PATH").pipe(
      Config.withDefault(path.join(home, ".pi", "agent", "pi-weixin", "state.json")),
    );
    const piWebBaseUrl = yield* Config.string("PI_WEB_BASE_URL").pipe(
      Config.withDefault(DEFAULT_PI_WEB_BASE_URL),
    );
    const store = yield* makeStateStore(statePath);
    const transport = makeIlinkClient(makeJsonHttpClient(httpClient));
    const gateway = yield* makePiGateway(makeJsonHttpClient(httpClient), piWebBaseUrl);
    const bridgeFiber = yield* Ref.make(Option.none<Fiber.Fiber<void, never>>());
    const loginFiber = yield* Ref.make(Option.none<Fiber.Fiber<WeixinAuth, LoginError>>());
    const lastError = yield* Ref.make(Option.none<string>());
    const connection = yield* Ref.make<BridgeConnectionState>({ _tag: "Stopped" });
    const retryAttempt = yield* Ref.make(0);
    const pollTimeoutMs = yield* Ref.make(38_000);
    const lifecycle = yield* Semaphore.make(1);
    const statusInvalidations = yield* PubSub.unbounded<void>({ replay: 1 });

    const status: BridgeService["status"] = Effect.gen(function* () {
      const state = yield* store.read;
      const runtimeConnection = yield* Ref.get(connection);
      const currentConnection: BridgeConnectionState =
        state.enabled && state.binding && !state.auth
          ? { _tag: "ReauthenticationRequired" }
          : runtimeConnection;
      const running =
        currentConnection._tag === "Connecting" ||
        currentConnection._tag === "Connected" ||
        currentConnection._tag === "Retrying";
      const error = yield* Ref.get(lastError);
      return {
        running,
        enabled: state.enabled,
        authenticated: state.auth !== undefined,
        ...(state.auth ? { accountId: state.auth.accountId } : {}),
        ...(state.binding ? { sessionId: state.binding.sessionId } : {}),
        ...(Option.isSome(error) ? { lastError: error.value } : {}),
        connection: currentConnection,
      };
    });
    const invalidateStatus = PubSub.publish(statusInvalidations, undefined).pipe(Effect.asVoid);
    const statusChanges = Stream.fromPubSub(statusInvalidations).pipe(
      Stream.mapEffect(() => Effect.exit(status)),
    );
    yield* invalidateStatus;

    const iteration = Effect.gen(function* () {
      let state = yield* store.read;
      if (!state.enabled || !state.auth || !state.binding) {
        return yield* new IlinkProtocolError({
          operation: "bridge.loop",
          cause: "bridge is not configured",
        });
      }
      yield* processUpdateBatch({}, { store, transport, gateway });
      state = yield* store.read;
      if (!state.auth) {
        return yield* new IlinkProtocolError({
          operation: "bridge.loop",
          cause: "bridge authentication changed during pending dispatch",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const timeoutMs = imageAwarePollTimeout(
        yield* Ref.get(pollTimeoutMs),
        state.pendingImageBatch,
        now,
      );
      const response = yield* transport.getUpdates(state.auth, state.cursor, timeoutMs);
      yield* processUpdateBatch(response, { store, transport, gateway });
      if (response.longpolling_timeout_ms !== undefined && response.longpolling_timeout_ms > 0) {
        yield* Ref.set(pollTimeoutMs, response.longpolling_timeout_ms);
      }
      yield* Ref.set(retryAttempt, 0);
      yield* Ref.set(connection, { _tag: "Connected" });
      yield* Ref.set(lastError, Option.none());
      yield* invalidateStatus;
    });

    const requireReauthentication = (error: IlinkSessionExpiredError) =>
      Effect.gen(function* () {
        yield* store.clearAuth;
        yield* Ref.set(connection, { _tag: "Stopped" });
        yield* Ref.set(lastError, Option.some("微信登录已失效，请执行 /weixin login"));
        yield* Effect.logWarning("微信登录凭证已失效", {
          operation: error.operation,
          code: error.code,
        });
        yield* invalidateStatus;
      });

    const retry = (error: BridgeLoopError) =>
      Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(retryAttempt, (value) => value + 1);
        const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        const jitter = yield* Random.nextIntBetween(0, 500);
        yield* Ref.set(connection, { _tag: "Retrying", attempt });
        yield* Ref.set(lastError, Option.some(describeError(error)));
        yield* invalidateStatus;
        yield* Effect.sleep(`${ceiling + jitter} millis`);
        return yield* Effect.suspend(runLoop);
      });

    const runLoop = (): Effect.Effect<void, never> =>
      iteration.pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error._tag === "IlinkSessionExpiredError"
              ? requireReauthentication(error).pipe(Effect.catch(retry))
              : retry(error),
          onSuccess: () => Effect.suspend(runLoop),
        }),
      );

    const stopFiber = <A, E>(ref: Ref.Ref<Option.Option<Fiber.Fiber<A, E>>>) =>
      Ref.getAndSet(ref, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
          }),
        ),
      );

    const presenceFailure = (operation: "start" | "stop") => (error: BridgeLoopError) =>
      Effect.logWarning(`微信在线状态 ${operation} 通知失败`, { error: error._tag });

    const notifyStart = (auth: WeixinAuth) =>
      transport.notifyStart(auth).pipe(
        // Presence reconciliation is advisory in iLink 2.4.6. Delivery remains valid
        // when it fails; remove this isolation if the server makes presence mandatory.
        Effect.tapError(presenceFailure("start")),
        Effect.ignore,
      );

    const notifyStop = (auth: WeixinAuth) =>
      transport.notifyStop(auth).pipe(Effect.tapError(presenceFailure("stop")), Effect.ignore);

    const startRaw = lifecycle.withPermits(1)(
      Effect.gen(function* () {
        if (Option.isSome(yield* Ref.get(bridgeFiber))) return false;
        const state = yield* store.read;
        if (!state.enabled || !state.auth || !state.binding) return false;
        yield* Ref.set(connection, { _tag: "Connecting" });
        yield* Ref.set(lastError, Option.none());
        yield* invalidateStatus;
        yield* notifyStart(state.auth);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const registered = yield* Deferred.make<void>();
            const fiber = yield* Effect.forkDetach(
              Deferred.await(registered).pipe(
                Effect.andThen(runLoop()),
                Effect.ensuring(Ref.set(bridgeFiber, Option.none())),
                Effect.ensuring(invalidateStatus),
              ),
            );
            yield* Ref.set(bridgeFiber, Option.some(fiber));
            yield* Deferred.succeed(registered, undefined);
            yield* Ref.set(connection, { _tag: "Connected" });
            yield* invalidateStatus;
          }),
        );
        return true;
      }),
    );

    const stopBridgeRaw = Effect.gen(function* () {
      const state = yield* Effect.option(store.read);
      yield* stopFiber(bridgeFiber);
      yield* Ref.set(connection, { _tag: "Stopped" });
      yield* Ref.set(retryAttempt, 0);
      if (Option.isSome(state) && state.value.auth) yield* notifyStop(state.value.auth);
    });
    const cancelLoginRaw = stopFiber(loginFiber);
    const cancelLogin = lifecycle.withPermits(1)(cancelLoginRaw);
    const stopRaw = lifecycle.withPermits(1)(
      Effect.gen(function* () {
        yield* cancelLoginRaw;
        yield* stopBridgeRaw;
      }),
    );
    const observeStatus = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.ensuring(invalidateStatus));

    const service: BridgeService = {
      status,
      statusChanges,
      start: observeStatus(startRaw),
      stop: observeStatus(stopRaw),
      cancelLogin,
      loginAndBind: (callbacks, binding) =>
        observeStatus(
          Effect.gen(function* () {
            const login = Effect.gen(function* () {
              const existing = yield* store.read;
              const auth = yield* transport.login(callbacks, existing.auth);
              yield* store.saveAuth(auth);
              yield* store.bind(binding);
              yield* startRaw;
              return auth;
            });
            const fiber = yield* lifecycle.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* cancelLoginRaw;
                  yield* stopBridgeRaw;
                  const fiber = yield* Effect.forkDetach(login);
                  yield* Ref.set(loginFiber, Option.some(fiber));
                  return fiber;
                }),
              ),
            );
            return yield* Fiber.join(fiber).pipe(
              Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
              Effect.ensuring(
                Ref.update(loginFiber, (current) =>
                  Option.isSome(current) && current.value === fiber ? Option.none() : current,
                ),
              ),
            );
          }),
        ),
      bind: (binding) =>
        observeStatus(store.bind(binding).pipe(Effect.andThen(startRaw), Effect.asVoid)),
      setEnabled: (enabled) =>
        observeStatus(
          enabled
            ? store.setEnabled(true).pipe(Effect.andThen(startRaw), Effect.asVoid)
            : stopRaw.pipe(Effect.andThen(store.setEnabled(false)), Effect.asVoid),
        ),
      logout: observeStatus(stopRaw.pipe(Effect.andThen(store.logout), Effect.asVoid)),
    };
    return service;
  }),
);
