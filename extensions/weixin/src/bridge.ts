import { acquireCrossProcessLease } from "@pipee/host-runtime/cross-process-lease";
import {
  Config,
  Context,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Random,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  BridgeConfigurationError,
  BridgeBusy,
  BridgeOwnershipConflict,
  GatewayError,
  GatewayIdempotencyConflictError,
  HttpRequestError,
  IlinkProtocolError,
  IlinkSessionExpiredError,
  RouteConflictError,
  RouteStoreError,
  QrCodeError,
  StateStoreError,
} from "./errors.ts";
import { DEFAULT_PIPEE_BASE_URL, makePiGateway, type PiGateway } from "./gateway.ts";
import { makeJsonHttpClient } from "./http.ts";
import { makeIlinkClient, type LoginCallbacks, type WeixinTransport } from "./ilink.ts";
import { IlinkMessageSchema, type IlinkImage, type UpdatesResponse } from "./ilink-protocol.ts";
import { cancelLogin, clearLogin, releaseSessionLogin } from "./login-ownership.ts";
import {
  messageIdentity,
  parseInboundMessage,
  progressClientId,
  renderInboundPrompt,
  replyClientId,
  splitTextReply,
} from "./message.ts";
import { makeRoutedMessenger, type RoutedMessenger } from "./routed-messenger.ts";
import { type PendingImageBatch, type SessionTarget, type WeixinAuth } from "./schema.ts";
import { makeStateStore, type StateStore } from "./state.ts";

const UNSUPPORTED_MESSAGE_REPLY = "当前 pi-weixin 仅支持文本和图片消息。";
const VOICE_TRANSCRIPTION_UNAVAILABLE_REPLY =
  "微信暂时没能识别这条语音，请重新发送语音，或直接发送文字。";
const MEDIA_ERROR_REPLY = "图片下载或解密失败，请重新发送原图。";
const IDEMPOTENCY_CONFLICT_REPLY =
  "上一条请求的执行状态无法安全确认。为避免重复执行，已停止自动重试；请检查 Pi 会话后重新发送。";
const UNKNOWN_REFERENCE_REPLY = "无法识别这条引用消息的来源。请取消引用后重新发送。";
const SESSION_UNAVAILABLE_REPLY = "引用对应的 Pi 会话已不可用。请取消引用后发送到默认会话。";
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
  readonly defaultSessionId?: string;
  readonly sendReady: boolean;
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
  | RouteStoreError
  | RouteConflictError
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
  messenger: RoutedMessenger,
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
      yield* messenger.sendText({
        auth,
        sourceSessionId: input.sessionId,
        text: MEDIA_ERROR_REPLY,
        contextToken: input.contextToken,
        clientId: replyClientId(input.requestId, 0),
      });
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
        messenger
          .sendText({
            auth,
            sourceSessionId: input.sessionId,
            text: `Pi 正在使用工具：${event.toolName}`,
            contextToken: input.contextToken,
            clientId: progressClientId(input.requestId, event.toolCallId),
          })
          .pipe(Effect.asVoid),
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (error) => stopTyping.pipe(Effect.andThen(Effect.fail(error))),
          onSuccess: (value) => stopTyping.pipe(Effect.as(value)),
        }),
        Effect.catchTags({
          GatewayIdempotencyConflictError: () => Effect.succeed(IDEMPOTENCY_CONFLICT_REPLY),
          GatewayError: (error) =>
            error.cause instanceof HttpRequestError && error.cause.status === 404
              ? Effect.succeed(SESSION_UNAVAILABLE_REPLY)
              : Effect.fail(error),
        }),
      );
    yield* Effect.forEach(
      splitTextReply(reply),
      (chunk, chunkIndex) =>
        messenger.sendText({
          auth,
          sourceSessionId: input.sessionId,
          text: chunk,
          contextToken: input.contextToken,
          clientId: replyClientId(input.requestId, chunkIndex),
        }),
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
    makeRoutedMessenger(dependencies.transport, dependencies.store.routes),
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
    const routes = store.routes;
    const messenger = makeRoutedMessenger(transport, routes);
    const initial = yield* store.read;
    if (!initial.auth || !initial.defaultSession) {
      return yield* new IlinkProtocolError({
        operation: "bridge.process_batch",
        cause: "微信账号或默认 Pi session 尚未配置",
      });
    }
    const auth = initial.auth;
    const defaultSession = initial.defaultSession;

    let ready = initial;
    if ((response.msgs?.length ?? 0) === 0) {
      ready = yield* store.transitionInbound({
        _tag: "ExpireImages",
        now: yield* Clock.currentTimeMillis,
      });
    }
    if (
      ready.pendingImageBatch?._tag === "Collecting" &&
      ready.pendingImageBatch.userId !== auth.userId
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
          const contextToken = message.context_token ?? "";
          if (contextToken) yield* store.saveContextToken(contextToken);
          const routedSessionId = inbound.referencedMessageId
            ? yield* routes.resolve(auth.accountId, inbound.referencedMessageId)
            : defaultSession.sessionId;
          if (inbound.referencedMessageId && routedSessionId === undefined) {
            yield* messenger.sendText({
              auth,
              sourceSessionId: defaultSession.sessionId,
              text: UNKNOWN_REFERENCE_REPLY,
              contextToken,
              clientId: replyClientId(id, 0),
            });
            yield* store.markProcessed(id);
            return;
          }
          const targetSessionId = routedSessionId ?? defaultSession.sessionId;
          const text = renderInboundPrompt(inbound);
          const imageParts = inbound.parts.filter((part) => part._tag === "Image");
          if (imageParts.some((part) => part.image === undefined)) {
            yield* messenger.sendText({
              auth,
              sourceSessionId: targetSessionId,
              text: MEDIA_ERROR_REPLY,
              contextToken,
              clientId: replyClientId(id, 0),
            });
            yield* store.markProcessed(id);
            return;
          }
          const images = imageParts.flatMap((part) => (part.image ? [part.image] : []));
          if (images.length > 0 && text === undefined) {
            const now = yield* Clock.currentTimeMillis;
            const collected = yield* store.transitionInbound({
              _tag: "CollectImages",
              sessionId: targetSessionId,
              userId: fromUserId,
              messageId: id,
              images,
              contextToken,
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
              sessionId: targetSessionId,
              userId: fromUserId,
              messageId: id,
              images,
              contextToken,
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
                sessionId: targetSessionId,
                userId: fromUserId,
                requestId: id,
                prompt,
                images: [],
                contextToken,
              },
              auth,
              transport,
              messenger,
              gateway,
            );
          } else {
            yield* messenger.sendText({
              auth,
              sourceSessionId: targetSessionId,
              text: fallbackReply,
              contextToken,
              clientId: replyClientId(id, 0),
            });
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
  | BridgeBusy
  | BridgeOwnershipConflict
  | StateStoreError
  | HttpRequestError
  | IlinkProtocolError
  | IlinkSessionExpiredError;
type BridgeLoopError = BatchError;

export interface BridgeService {
  readonly status: Effect.Effect<BridgeStatus, StateStoreError>;
  readonly statusChanges: Stream.Stream<Exit.Exit<BridgeStatus, StateStoreError>>;
  readonly start: Effect.Effect<boolean, StateStoreError | BridgeOwnershipConflict>;
  readonly stop: Effect.Effect<void>;
  readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
  readonly connect: (
    callbacks: LoginCallbacks<QrCodeError | BridgeConfigurationError>,
    session: SessionTarget,
  ) => Effect.Effect<WeixinAuth, LoginError>;
  readonly setDefaultSession: (session: SessionTarget) => Effect.Effect<void, StateStoreError>;
  readonly sendText: (
    sourceSessionId: string,
    text: string,
    clientId: string,
  ) => Effect.Effect<
    string,
    | StateStoreError
    | BridgeConfigurationError
    | HttpRequestError
    | IlinkProtocolError
    | IlinkSessionExpiredError
    | RouteStoreError
    | RouteConflictError
  >;
  readonly setEnabled: (
    enabled: boolean,
  ) => Effect.Effect<void, StateStoreError | BridgeOwnershipConflict | BridgeConfigurationError>;
  readonly logout: Effect.Effect<void, StateStoreError>;
}

export class Bridge extends Context.Service<Bridge, BridgeService>()("pi-weixin/Bridge") {}

const describeError = (error: BridgeLoopError): string => error._tag;

export const BridgeLive = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const home = yield* Config.string("HOME").pipe(
      Effect.mapError(() => new BridgeConfigurationError({ reason: "HOME is not configured" })),
    );
    const statePath = yield* Config.string("PI_WEIXIN_STATE_PATH").pipe(
      Config.withDefault(path.join(home, ".pi", "agent", "pi-weixin", "state.json")),
    );
    yield* acquireCrossProcessLease(`${statePath}.lease.sqlite`).pipe(
      Effect.mapError((error) =>
        error._tag === "LeaseUnavailable"
          ? new BridgeOwnershipConflict({ resource: "state" })
          : new BridgeConfigurationError({ reason: `无法获取微信状态 ownership：${error.path}` }),
      ),
    );
    const piWebBaseUrl = yield* Config.string("PIPEE_BASE_URL").pipe(
      Config.withDefault(DEFAULT_PIPEE_BASE_URL),
    );
    const serviceScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.succeed(undefined)));
    const store = yield* makeStateStore(statePath).pipe(
      Effect.provideService(Scope.Scope, serviceScope),
    );
    const routes = store.routes;
    const transport = makeIlinkClient(makeJsonHttpClient(httpClient));
    const messenger = makeRoutedMessenger(transport, routes);
    const gateway = yield* makePiGateway(makeJsonHttpClient(httpClient), piWebBaseUrl);
    const bridgeFiber = yield* Ref.make(Option.none<Fiber.Fiber<void, never>>());
    const loginFiber = yield* Ref.make(
      Option.none<{
        readonly ownerSessionId: string;
        readonly fiber: Fiber.Fiber<WeixinAuth, LoginError>;
      }>(),
    );
    const accountOwner = yield* Ref.make(
      Option.none<{ readonly accountId: string; readonly scope: Scope.Closeable }>(),
    );
    const lastError = yield* Ref.make(Option.none<string>());
    const connection = yield* Ref.make<BridgeConnectionState>({ _tag: "Stopped" });
    const retryAttempt = yield* Ref.make(0);
    const pollTimeoutMs = yield* Ref.make(38_000);
    const lifecycle = yield* Semaphore.make(1);
    const statusInvalidations = yield* PubSub.unbounded<void>({ replay: 1 });

    const closeAccountOwner = Ref.getAndSet(accountOwner, Option.none()).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ scope }) => Scope.close(scope, Exit.succeed(undefined)),
        }),
      ),
    );

    const acquireAccountOwner = (accountId: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(accountOwner);
        if (Option.isSome(current) && current.value.accountId === accountId) return;
        if (Option.isSome(current)) yield* closeAccountOwner;
        const scope = yield* Scope.make("sequential");
        yield* acquireCrossProcessLease(
          path.join(
            home,
            ".pi",
            "agent",
            "pi-weixin",
            "accounts",
            `${encodeURIComponent(accountId)}.lease.sqlite`,
          ),
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(() => new BridgeOwnershipConflict({ resource: "account" })),
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
        yield* Ref.set(accountOwner, Option.some({ accountId, scope }));
      });

    const status: BridgeService["status"] = Effect.gen(function* () {
      const state = yield* store.read;
      const runtimeConnection = yield* Ref.get(connection);
      const currentConnection: BridgeConnectionState =
        state.enabled && state.defaultSession && !state.auth
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
        sendReady: state.auth !== undefined && Boolean(state.contextToken),
        ...(state.auth ? { accountId: state.auth.accountId } : {}),
        ...(state.defaultSession ? { defaultSessionId: state.defaultSession.sessionId } : {}),
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
      if (!state.enabled || !state.auth || !state.defaultSession) {
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
        yield* closeAccountOwner;
        yield* Ref.set(connection, { _tag: "Stopped" });
        yield* Ref.set(lastError, Option.some("微信登录已失效，请让 Agent 重新连接微信"));
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

    const startBridgeRaw = Effect.gen(function* () {
      if (Option.isSome(yield* Ref.get(bridgeFiber))) return false;
      const state = yield* store.read;
      if (!state.enabled || !state.auth || !state.defaultSession) return false;
      yield* acquireAccountOwner(state.auth.accountId);
      yield* Ref.set(connection, { _tag: "Connecting" });
      yield* Ref.set(lastError, Option.none());
      yield* invalidateStatus;
      yield* notifyStart(state.auth);
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const registered = yield* Deferred.make<void>();
          const fiber = yield* Deferred.await(registered).pipe(
            Effect.andThen(runLoop()),
            Effect.ensuring(Ref.set(bridgeFiber, Option.none())),
            Effect.ensuring(invalidateStatus),
            Effect.forkIn(serviceScope),
          );
          yield* Ref.set(bridgeFiber, Option.some(fiber));
          yield* Deferred.succeed(registered, undefined);
          yield* Ref.set(connection, { _tag: "Connected" });
          yield* invalidateStatus;
        }),
      );
      return true;
    });
    const startRaw = lifecycle.withPermits(1)(startBridgeRaw);

    const stopBridgeRaw = Effect.gen(function* () {
      const state = yield* Effect.option(store.read);
      yield* stopFiber(bridgeFiber);
      yield* Ref.set(connection, { _tag: "Stopped" });
      yield* Ref.set(retryAttempt, 0);
      if (Option.isSome(state) && state.value.auth) yield* notifyStop(state.value.auth);
      yield* closeAccountOwner;
    });
    const cancelLoginRaw = cancelLogin(loginFiber);
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
      releaseSession: (sessionId) =>
        lifecycle.withPermits(1)(releaseSessionLogin(loginFiber, sessionId)),
      connect: (callbacks, session) =>
        observeStatus(
          Effect.gen(function* () {
            const login = Effect.gen(function* () {
              const existing = yield* store.read;
              const auth = yield* transport.login(callbacks, existing.auth);
              yield* acquireAccountOwner(auth.accountId);
              yield* store.saveAuth(auth);
              const configured = yield* store.read;
              if (!configured.defaultSession) yield* store.setDefaultSession(session);
              yield* store.setEnabled(true);
              yield* startRaw;
              return auth;
            }).pipe(Effect.onError(() => closeAccountOwner));
            const fiber = yield* lifecycle.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const active = yield* Ref.get(loginFiber);
                  if (Option.isSome(active)) {
                    return yield* new BridgeBusy({
                      operation: "login",
                      ownerSessionId: active.value.ownerSessionId,
                    });
                  }
                  yield* stopBridgeRaw;
                  const fiber = yield* login.pipe(Effect.forkIn(serviceScope));
                  yield* Ref.set(
                    loginFiber,
                    Option.some({ ownerSessionId: session.sessionId, fiber }),
                  );
                  return fiber;
                }),
              ),
            );
            return yield* Fiber.join(fiber).pipe(
              Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
              Effect.ensuring(clearLogin(loginFiber, fiber)),
            );
          }),
        ),
      setDefaultSession: (session) =>
        observeStatus(store.setDefaultSession(session).pipe(Effect.asVoid)),
      sendText: (sourceSessionId, text, clientId) =>
        Effect.gen(function* () {
          const state = yield* store.read;
          if (!state.auth) {
            return yield* new BridgeConfigurationError({ reason: "微信尚未登录" });
          }
          if (!state.contextToken) {
            return yield* new BridgeConfigurationError({
              reason: "尚未收到微信消息，缺少主动发送所需的 context token",
            });
          }
          const receipt = yield* messenger.sendText({
            auth: state.auth,
            sourceSessionId,
            text,
            contextToken: state.contextToken,
            clientId,
          });
          return receipt.serverMessageId;
        }),
      setEnabled: (enabled) =>
        observeStatus(
          enabled
            ? Effect.gen(function* () {
                const state = yield* store.read;
                if (!state.auth || !state.defaultSession) {
                  return yield* new BridgeConfigurationError({
                    reason: "启用微信前必须先登录并设置默认会话",
                  });
                }
                yield* store.setEnabled(true);
                yield* startRaw;
              })
            : stopRaw.pipe(Effect.andThen(store.setEnabled(false)), Effect.asVoid),
        ),
      logout: observeStatus(stopRaw.pipe(Effect.andThen(store.logout), Effect.asVoid)),
    };
    yield* Effect.addFinalizer(() => stopRaw);
    return service;
  }),
);
