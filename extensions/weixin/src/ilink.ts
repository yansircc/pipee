import { createDecipheriv } from "node:crypto";
import { Clock, DateTime, Effect, Random, Schema } from "effect";
import {
  HttpRequestError,
  IlinkMediaError,
  IlinkProtocolError,
  IlinkSessionExpiredError,
} from "./errors.ts";
import type { JsonHttpClient } from "./http.ts";
import type { ImageContent } from "./media.ts";
import {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_BASE_URL,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_BOT_AGENT,
  ILINK_BOT_TYPE,
  ILINK_CHANNEL_VERSION,
  LoginQrResponseSchema,
  LoginStatusResponseSchema,
  IlinkResponseSchema,
  TypingConfigResponseSchema,
  UpdatesResponseSchema,
  type LoginStatus,
  type LoginStatusResponse,
  type IlinkImage,
  type UpdatesResponse,
} from "./ilink-protocol.ts";
import type { WeixinAuth } from "./schema.ts";

export type LoginEvent =
  | { readonly _tag: "AwaitingScan" }
  | { readonly _tag: "Scanned" }
  | { readonly _tag: "AwaitingVerifyCode"; readonly retry: boolean }
  | { readonly _tag: "VerifyCodeAccepted" }
  | { readonly _tag: "QrRefreshed"; readonly reason: "expired" | "verify-code-blocked" }
  | { readonly _tag: "Redirected"; readonly baseUrl: string }
  | { readonly _tag: "PollingRetry" }
  | { readonly _tag: "AlreadyConnected" };

export interface LoginCallbacks<E> {
  readonly onQr: (content: string) => Effect.Effect<void, E>;
  readonly onEvent: (event: LoginEvent) => Effect.Effect<void, E>;
  readonly requestVerifyCode: (retry: boolean) => Effect.Effect<string, E>;
}

interface TypingHandle {
  readonly userId: string;
  readonly ticket: string;
}

type ProtocolError = HttpRequestError | IlinkProtocolError | IlinkSessionExpiredError;

export interface WeixinTransport {
  readonly login: <E>(
    callbacks: LoginCallbacks<E>,
    knownAuth?: WeixinAuth,
  ) => Effect.Effect<WeixinAuth, E | ProtocolError>;
  readonly getUpdates: (
    auth: WeixinAuth,
    cursor: string,
    timeoutMs: number,
  ) => Effect.Effect<UpdatesResponse, ProtocolError>;
  readonly sendText: (
    auth: WeixinAuth,
    toUserId: string,
    text: string,
    contextToken: string,
    clientId: string,
  ) => Effect.Effect<void, ProtocolError>;
  readonly startTyping: (
    auth: WeixinAuth,
    userId: string,
    contextToken: string,
  ) => Effect.Effect<TypingHandle, ProtocolError>;
  readonly stopTyping: (
    auth: WeixinAuth,
    handle: TypingHandle,
  ) => Effect.Effect<void, ProtocolError>;
  readonly notifyStart: (auth: WeixinAuth) => Effect.Effect<void, ProtocolError>;
  readonly notifyStop: (auth: WeixinAuth) => Effect.Effect<void, ProtocolError>;
  readonly downloadImage: (
    image: IlinkImage,
  ) => Effect.Effect<ImageContent, HttpRequestError | IlinkMediaError>;
}

const protocolError = (operation: string) => (cause: unknown) =>
  new IlinkProtocolError({ operation, cause });

const requireSuccess = <
  A extends {
    readonly ret?: number | undefined;
    readonly errcode?: number | undefined;
    readonly errmsg?: string | undefined;
  },
>(
  operation: string,
  value: A,
): Effect.Effect<A, IlinkProtocolError | IlinkSessionExpiredError> => {
  const code = value.errcode !== undefined && value.errcode !== 0 ? value.errcode : value.ret;
  if (code === -14) {
    return Effect.fail(
      new IlinkSessionExpiredError({
        operation,
        code: -14,
        cause: value.errmsg ?? "iLink token is stale",
      }),
    );
  }
  return code !== undefined && code !== 0
    ? Effect.fail(protocolError(operation)(`iLink code=${code}: ${value.errmsg ?? "unknown"}`))
    : Effect.succeed(value);
};

const requireText = (operation: string, field: string, value: string | undefined) =>
  value ? Effect.succeed(value) : Effect.fail(protocolError(operation)(`Missing ${field}`));

const commonHeaders = ILINK_APP_CLIENT_VERSION.pipe(
  Effect.map((clientVersion) => ({
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(clientVersion),
  })),
);

const baseInfo = {
  channel_version: ILINK_CHANNEL_VERSION,
  bot_agent: ILINK_BOT_AGENT,
};

const ILINK_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const mediaError = (
  operation: IlinkMediaError["operation"],
  reason: IlinkMediaError["reason"],
  cause: unknown,
) => new IlinkMediaError({ operation, reason, cause });

const imageDownloadUrl = (image: IlinkImage): Effect.Effect<string, IlinkMediaError> => {
  const fullUrl = image.media?.full_url;
  if (fullUrl) {
    return Effect.try({
      try: () => new URL(fullUrl),
      catch: (cause) => mediaError("download", "InvalidReference", cause),
    }).pipe(
      Effect.flatMap((url) =>
        url.protocol === "https:" &&
        (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))
          ? Effect.succeed(url.toString())
          : Effect.fail(
              mediaError("download", "InvalidReference", "Image URL is not a Weixin HTTPS URL"),
            ),
      ),
    );
  }
  const query = image.media?.encrypt_query_param;
  if (!query) {
    return Effect.fail(
      mediaError("download", "InvalidReference", "Image has no CDN download reference"),
    );
  }
  const url = new URL(`${DEFAULT_ILINK_CDN_BASE_URL}/download`);
  url.searchParams.set("encrypted_query_param", query);
  return Effect.succeed(url.toString());
};

const imageAesKey = (image: IlinkImage): Effect.Effect<Buffer | undefined, IlinkMediaError> => {
  if (image.aeskey !== undefined) {
    return /^[0-9a-fA-F]{32}$/.test(image.aeskey)
      ? Effect.succeed(Buffer.from(image.aeskey, "hex"))
      : Effect.fail(mediaError("decrypt", "InvalidKey", "image_item.aeskey is not 16-byte hex"));
  }
  if (image.media?.aes_key === undefined) return Effect.succeed(undefined);
  const decoded = Buffer.from(image.media.aes_key, "base64");
  if (decoded.length === 16) return Effect.succeed(decoded);
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Effect.succeed(Buffer.from(decoded.toString("ascii"), "hex"));
  }
  return Effect.fail(
    mediaError("decrypt", "InvalidKey", "media.aes_key does not encode a 16-byte key"),
  );
};

const decryptImage = (
  encrypted: Uint8Array,
  key: Buffer | undefined,
): Effect.Effect<Buffer, IlinkMediaError> =>
  key === undefined
    ? Effect.succeed(Buffer.from(encrypted))
    : Effect.try({
        try: () => {
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          return Buffer.concat([decipher.update(encrypted), decipher.final()]);
        },
        catch: (cause) => mediaError("decrypt", "InvalidContent", cause),
      });

const imageMimeType = (bytes: Buffer): Effect.Effect<string, IlinkMediaError> => {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("ascii");
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return Effect.succeed("image/jpeg");
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return Effect.succeed("image/png");
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return Effect.succeed("image/gif");
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return Effect.succeed("image/webp");
  }
  if (ascii(0, 2) === "BM") return Effect.succeed("image/bmp");
  return Effect.fail(
    mediaError("decode", "InvalidContent", "Downloaded media is not a supported image"),
  );
};

const redirectBaseUrl = (host: string): Effect.Effect<string, IlinkProtocolError> =>
  Effect.try({
    try: () => new URL(`https://${host}`),
    catch: protocolError("ilink.login.redirect"),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:" &&
      url.hostname === host &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
        ? Effect.succeed(url.origin)
        : Effect.fail(protocolError("ilink.login.redirect")("invalid redirect host")),
    ),
  );

export const makeIlinkClient = (http: JsonHttpClient): WeixinTransport => {
  const post = (
    operation: string,
    baseUrl: string,
    endpoint: string,
    token: string,
    body: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ) =>
    Effect.gen(function* () {
      const headers = yield* commonHeaders;
      const uin = yield* Random.nextIntBetween(0, 0x1_0000_0000);
      return yield* http.request({
        operation,
        method: "POST",
        url: `${baseUrl.replace(/\/$/, "")}/${endpoint}`,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${token}`,
          "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
        },
        body: { ...body, base_info: baseInfo },
        timeout: `${timeoutMs} millis`,
      });
    });

  const decodeResponse = <S extends Schema.Top & { readonly DecodingServices: never }>(
    operation: string,
    schema: S,
    raw: unknown,
  ): Effect.Effect<S["Type"], IlinkProtocolError> =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(protocolError(operation)));

  const getLoginQr = (knownAuth: WeixinAuth | undefined) =>
    Effect.gen(function* () {
      const headers = yield* commonHeaders;
      const raw = yield* http.request({
        operation: "ilink.login.qr",
        method: "POST",
        url: `${DEFAULT_ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
        headers: { ...headers, "Content-Type": "application/json" },
        body: { local_token_list: knownAuth ? [knownAuth.token] : [] },
      });
      const decoded = yield* decodeResponse("ilink.login.qr", LoginQrResponseSchema, raw);
      return yield* requireSuccess("ilink.login.qr", decoded);
    });

  return {
    login: <E>(callbacks: LoginCallbacks<E>, knownAuth?: WeixinAuth) =>
      Effect.gen(function* () {
        const first = yield* getLoginQr(knownAuth);
        yield* callbacks.onQr(first.qrcode_img_content);
        yield* callbacks.onEvent({ _tag: "AwaitingScan" });
        const startedAt = yield* Clock.currentTimeMillis;

        interface LoginState {
          readonly baseUrl: string;
          readonly qrcode: string;
          readonly refreshes: number;
          readonly verifyCode?: string;
        }

        const continuePolling = (state: LoginState) =>
          Effect.sleep("1 second").pipe(Effect.andThen(Effect.suspend(() => poll(state))));

        const refreshQr = (state: LoginState, reason: "expired" | "verify-code-blocked") =>
          Effect.gen(function* () {
            if (state.refreshes >= 3) {
              return yield* protocolError("ilink.login")("微信二维码多次失效");
            }
            const next = yield* getLoginQr(knownAuth);
            yield* callbacks.onQr(next.qrcode_img_content);
            yield* callbacks.onEvent({ _tag: "QrRefreshed", reason });
            return yield* continuePolling({
              baseUrl: DEFAULT_ILINK_BASE_URL,
              qrcode: next.qrcode,
              refreshes: state.refreshes + 1,
            });
          });

        type Handler = (
          status: LoginStatusResponse,
          state: LoginState,
        ) => Effect.Effect<WeixinAuth, E | ProtocolError>;

        const handlers: Record<LoginStatus, Handler> = {
          wait: (_status, state) => continuePolling(state),
          scaned: (_status, state) =>
            Effect.gen(function* () {
              yield* callbacks.onEvent(
                state.verifyCode ? { _tag: "VerifyCodeAccepted" } : { _tag: "Scanned" },
              );
              const { verifyCode: _accepted, ...next } = state;
              return yield* continuePolling(next);
            }),
          confirmed: (status) =>
            Effect.gen(function* () {
              const token = yield* requireText("ilink.login", "bot_token", status.bot_token);
              const accountId = yield* requireText(
                "ilink.login",
                "ilink_bot_id",
                status.ilink_bot_id,
              );
              const userId = yield* requireText(
                "ilink.login",
                "ilink_user_id",
                status.ilink_user_id,
              );
              return {
                token,
                baseUrl: status.baseurl ?? DEFAULT_ILINK_BASE_URL,
                accountId,
                userId,
                savedAt: DateTime.formatIso(yield* DateTime.now),
              };
            }),
          expired: (_status, state) => refreshQr(state, "expired"),
          scaned_but_redirect: (status, state) =>
            Effect.gen(function* () {
              const host = yield* requireText(
                "ilink.login.redirect",
                "redirect_host",
                status.redirect_host,
              );
              const baseUrl = yield* redirectBaseUrl(host);
              yield* callbacks.onEvent({ _tag: "Redirected", baseUrl });
              return yield* Effect.suspend(() => poll({ ...state, baseUrl }));
            }),
          binded_redirect: () =>
            knownAuth
              ? callbacks.onEvent({ _tag: "AlreadyConnected" }).pipe(Effect.as(knownAuth))
              : Effect.fail(
                  protocolError("ilink.login")("服务端报告账号已绑定，但本地没有可复用的登录凭证"),
                ),
          need_verifycode: (_status, state) =>
            Effect.gen(function* () {
              const retry = state.verifyCode !== undefined;
              yield* callbacks.onEvent({ _tag: "AwaitingVerifyCode", retry });
              const verifyCode = yield* callbacks.requestVerifyCode(retry);
              if (!verifyCode.trim()) {
                return yield* protocolError("ilink.login.verify_code")("配对码不能为空");
              }
              return yield* Effect.suspend(() => poll({ ...state, verifyCode: verifyCode.trim() }));
            }),
          verify_code_blocked: (_status, state) => refreshQr(state, "verify-code-blocked"),
        };

        const poll = (state: LoginState): Effect.Effect<WeixinAuth, E | ProtocolError> =>
          Effect.gen(function* () {
            const headers = yield* commonHeaders;
            const now = yield* Clock.currentTimeMillis;
            if (now >= startedAt + 5 * 60_000) {
              return yield* protocolError("ilink.login")("微信登录超时");
            }
            const query = new URLSearchParams({ qrcode: state.qrcode });
            if (state.verifyCode) query.set("verify_code", state.verifyCode);
            const outcome = yield* http
              .request({
                operation: "ilink.login.status",
                method: "GET",
                url: `${state.baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
                headers,
                timeout: "38 seconds",
              })
              .pipe(
                Effect.map((raw) => ({ _tag: "Response" as const, raw })),
                Effect.catchTag("HttpRequestError", () =>
                  callbacks.onEvent({ _tag: "PollingRetry" }).pipe(
                    Effect.andThen(continuePolling(state)),
                    Effect.map((auth) => ({ _tag: "Authenticated" as const, auth })),
                  ),
                ),
              );
            if (outcome._tag === "Authenticated") return outcome.auth;
            const status = yield* decodeResponse(
              "ilink.login.status",
              LoginStatusResponseSchema,
              outcome.raw,
            );
            yield* requireSuccess("ilink.login.status", status);
            return yield* handlers[status.status](status, state);
          });

        return yield* poll({
          baseUrl: DEFAULT_ILINK_BASE_URL,
          qrcode: first.qrcode,
          refreshes: 0,
        });
      }),

    getUpdates: (auth, cursor, timeoutMs) =>
      post(
        "ilink.get_updates",
        auth.baseUrl,
        "ilink/bot/getupdates",
        auth.token,
        { get_updates_buf: cursor },
        timeoutMs,
      ).pipe(
        Effect.catchTag("HttpRequestError", (error) =>
          error.cause === "timeout"
            ? Effect.succeed({ ret: 0, msgs: [], get_updates_buf: cursor })
            : Effect.fail(error),
        ),
        Effect.flatMap((raw) => decodeResponse("ilink.get_updates", UpdatesResponseSchema, raw)),
        Effect.flatMap((value) => requireSuccess("ilink.get_updates", value)),
      ),

    sendText: (auth, toUserId, text, contextToken, clientId) =>
      post(
        "ilink.send_text",
        auth.baseUrl,
        "ilink/bot/sendmessage",
        auth.token,
        {
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
        },
        15_000,
      ).pipe(
        Effect.flatMap((raw) => decodeResponse("ilink.send_text", IlinkResponseSchema, raw)),
        Effect.flatMap((value) => requireSuccess("ilink.send_text", value)),
        Effect.asVoid,
      ),

    startTyping: (auth, userId, contextToken) =>
      post(
        "ilink.get_config",
        auth.baseUrl,
        "ilink/bot/getconfig",
        auth.token,
        { ilink_user_id: userId, context_token: contextToken },
        10_000,
      ).pipe(
        Effect.flatMap((raw) =>
          decodeResponse("ilink.get_config", TypingConfigResponseSchema, raw),
        ),
        Effect.flatMap((value) => requireSuccess("ilink.get_config", value)),
        Effect.flatMap((value) =>
          requireText("ilink.get_config", "typing_ticket", value.typing_ticket),
        ),
        Effect.flatMap((ticket) =>
          post(
            "ilink.start_typing",
            auth.baseUrl,
            "ilink/bot/sendtyping",
            auth.token,
            { ilink_user_id: userId, typing_ticket: ticket, status: 1 },
            10_000,
          ).pipe(
            Effect.flatMap((raw) => decodeResponse("ilink.start_typing", IlinkResponseSchema, raw)),
            Effect.flatMap((value) => requireSuccess("ilink.start_typing", value)),
            Effect.as({ userId, ticket }),
          ),
        ),
      ),

    stopTyping: (auth, handle) =>
      post(
        "ilink.stop_typing",
        auth.baseUrl,
        "ilink/bot/sendtyping",
        auth.token,
        { ilink_user_id: handle.userId, typing_ticket: handle.ticket, status: 2 },
        10_000,
      ).pipe(
        Effect.flatMap((raw) => decodeResponse("ilink.stop_typing", IlinkResponseSchema, raw)),
        Effect.flatMap((value) => requireSuccess("ilink.stop_typing", value)),
        Effect.asVoid,
      ),

    notifyStart: (auth) =>
      post(
        "ilink.notify_start",
        auth.baseUrl,
        "ilink/bot/msg/notifystart",
        auth.token,
        {},
        10_000,
      ).pipe(
        Effect.flatMap((raw) => decodeResponse("ilink.notify_start", IlinkResponseSchema, raw)),
        Effect.flatMap((value) => requireSuccess("ilink.notify_start", value)),
        Effect.asVoid,
      ),

    notifyStop: (auth) =>
      post(
        "ilink.notify_stop",
        auth.baseUrl,
        "ilink/bot/msg/notifystop",
        auth.token,
        {},
        10_000,
      ).pipe(
        Effect.flatMap((raw) => decodeResponse("ilink.notify_stop", IlinkResponseSchema, raw)),
        Effect.flatMap((value) => requireSuccess("ilink.notify_stop", value)),
        Effect.asVoid,
      ),

    downloadImage: (image) =>
      Effect.gen(function* () {
        const url = yield* imageDownloadUrl(image);
        const key = yield* imageAesKey(image);
        const encrypted = yield* http.bytes(
          {
            operation: "ilink.download_image",
            method: "GET",
            url,
            timeout: "30 seconds",
          },
          ILINK_IMAGE_MAX_BYTES,
        );
        const decrypted = yield* decryptImage(encrypted, key);
        const mimeType = yield* imageMimeType(decrypted);
        return { data: decrypted.toString("base64"), mimeType };
      }).pipe(Effect.withSpan("pi_weixin.ilink.download_image")),
  };
};
