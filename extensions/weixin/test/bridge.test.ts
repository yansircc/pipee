import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  GatewayError,
  GatewayIdempotencyConflictError,
  HttpRequestError,
  IlinkMediaError,
  IlinkSessionExpiredError,
} from "../src/errors.ts";
import { imageAwarePollTimeout, processUpdateBatch } from "../src/bridge.ts";
import type { PiGateway } from "../src/gateway.ts";
import type { WeixinTransport } from "../src/ilink.ts";
import { makeStateStore, type StateStore } from "../src/state.ts";
import { configureStore, withTestStore } from "./runtime.ts";

const unusedLogin: WeixinTransport["login"] = () => Effect.never;
let outboundSequence = 0;
const outboundReceipt = (clientId = `client-${outboundSequence + 1}`) =>
  Effect.sync(() => ({ serverMessageId: String(++outboundSequence), clientId }));

const imageMessage = (messageId: number, imageId: string) => ({
  message_id: messageId,
  message_type: 1,
  from_user_id: "allowed-user",
  context_token: `context-${messageId}`,
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: imageId } } }],
});

const imageDependencies = (
  store: StateStore,
  prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }>,
) =>
  ({
    store,
    gateway: {
      promptAndWait: (_sessionId, _requestId, message, images) =>
        Effect.sync(() => {
          prompts.push({
            message,
            images: images.map((image) => ({ data: image.data })),
          });
          return "完成";
        }),
    },
    transport: {
      login: unusedLogin,
      getUpdates: () => Effect.succeed({}),
      startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
      stopTyping: () => Effect.void,
      notifyStart: () => Effect.void,
      notifyStop: () => Effect.void,
      downloadImage: (image) =>
        Effect.succeed({
          data: image.media?.encrypt_query_param ?? "missing",
          mimeType: "image/png",
        }),
      sendText: (_auth, _to, _text, _context, clientId) => outboundReceipt(clientId),
    },
  }) satisfies { store: StateStore; gateway: PiGateway; transport: WeixinTransport };

it.effect("authorized messages reach Pi once and use deterministic ids for every reply chunk", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: string[] = [];
      const replies: Array<{ text: string; clientId: string }> = [];
      const typing: string[] = [];
      const gateway: PiGateway = {
        promptAndWait: (sessionId, requestId, message, images, onProgress) =>
          Effect.gen(function* () {
            expect(sessionId).toBe("pi-session");
            expect(requestId).toMatch(/^[a-f0-9]{64}$/);
            prompts.push(message);
            expect(images).toEqual([]);
            yield* onProgress({
              _tag: "ToolStarted",
              runId: "run-1",
              toolCallId: "tool-1",
              toolName: "browser",
            });
            return "a".repeat(4_001);
          }),
      };
      const transport: WeixinTransport = {
        login: unusedLogin,
        getUpdates: () => Effect.succeed({}),
        startTyping: (_auth, userId) =>
          Effect.sync(() => {
            typing.push("start");
            return { userId, ticket: "ticket" };
          }),
        stopTyping: () => Effect.sync(() => typing.push("stop")),
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: () => Effect.die("unused image download"),
        sendText: (_auth, _to, text, _context, clientId) =>
          Effect.sync(() => {
            replies.push({ text, clientId });
            return { serverMessageId: String(++outboundSequence), clientId };
          }),
      };
      const response = {
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_type: 1,
            from_user_id: "allowed-user",
            context_token: "context",
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          },
        ],
      };

      yield* processUpdateBatch(response, { store, transport, gateway });
      yield* processUpdateBatch(response, { store, transport, gateway });

      expect(prompts).toEqual(["hello"]);
      expect(replies.map((reply) => reply.text)).toEqual([
        "Pi 正在使用工具：browser",
        "a".repeat(4_000),
        "a",
      ]);
      expect(replies[0]?.clientId).toMatch(/^piw-[a-f0-9]{32}$/);
      expect(replies[1]?.clientId).toMatch(/^piw-[a-f0-9]{32}$/);
      expect(new Set(replies.map((reply) => reply.clientId))).toHaveLength(3);
      expect(typing).toEqual(["start", "stop"]);
      expect((yield* store.read).cursor).toBe("cursor-2");
      expect((yield* store.read).contextToken).toBe("context");
    }),
  ),
);

it.effect("routes a quoted server message id to its exact source session", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      yield* store.routes.record({
        accountId: "bot",
        serverMessageId: "7483914874329324552",
        sourceSessionId: "source-session",
        clientId: "source-client",
        createdAt: 1,
      });
      const promptedSessions: string[] = [];
      const transport: WeixinTransport = {
        login: unusedLogin,
        getUpdates: () => Effect.succeed({}),
        startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
        stopTyping: () => Effect.void,
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: () => Effect.die("unused"),
        sendText: (_auth, _to, _text, _context, clientId) => outboundReceipt(clientId),
      };
      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: "9007199254740993",
              message_type: 1,
              from_user_id: "allowed-user",
              context_token: "quoted-context",
              item_list: [
                {
                  type: 1,
                  text_item: { text: "继续处理" },
                  ref_msg: {
                    title: "引用",
                    message_item: {
                      msg_id: "7483914874329324552",
                      type: 1,
                      text_item: { text: "原消息" },
                    },
                  },
                },
              ],
            },
          ],
        },
        {
          store,
          transport,
          gateway: {
            promptAndWait: (sessionId) =>
              Effect.sync(() => {
                promptedSessions.push(sessionId);
                return "完成";
              }),
          },
        },
      );
      expect(promptedSessions).toEqual(["source-session"]);
    }),
  ),
);

it.effect("fails closed for an unknown quoted server message id", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const replies: string[] = [];
      let prompted = false;
      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: "9007199254740994",
              message_type: 1,
              from_user_id: "allowed-user",
              context_token: "quoted-context",
              item_list: [
                {
                  type: 1,
                  text_item: { text: "继续处理" },
                  ref_msg: { message_item: { msg_id: "7483914874329324999", type: 1 } },
                },
              ],
            },
          ],
        },
        {
          store,
          gateway: {
            promptAndWait: () =>
              Effect.sync(() => {
                prompted = true;
                return "unexpected";
              }),
          },
          transport: {
            login: unusedLogin,
            getUpdates: () => Effect.succeed({}),
            startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
            stopTyping: () => Effect.void,
            notifyStart: () => Effect.void,
            notifyStop: () => Effect.void,
            downloadImage: () => Effect.die("unused"),
            sendText: (_auth, _to, text, _context, clientId) =>
              Effect.sync(() => {
                replies.push(text);
                return { serverMessageId: String(++outboundSequence), clientId };
              }),
          },
        },
      );
      expect(prompted).toBe(false);
      expect(replies).toEqual(["无法识别这条引用消息的来源。请取消引用后重新发送。"]);
    }),
  ),
);

it.effect("reports a deleted target session without falling back to the default", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      yield* store.routes.record({
        accountId: "bot",
        serverMessageId: "7483914874329324552",
        sourceSessionId: "deleted-session",
        clientId: "deleted-client",
        createdAt: 1,
      });
      const replies: string[] = [];
      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: "9007199254740995",
              message_type: 1,
              from_user_id: "allowed-user",
              context_token: "context",
              item_list: [
                {
                  type: 1,
                  text_item: { text: "继续" },
                  ref_msg: { message_item: { msg_id: "7483914874329324552", type: 1 } },
                },
              ],
            },
          ],
        },
        {
          store,
          gateway: {
            promptAndWait: (sessionId) =>
              Effect.fail(
                new GatewayError({
                  sessionId,
                  cause: new HttpRequestError({
                    operation: "pi.prompt",
                    url: "http://127.0.0.1/session",
                    cause: "HTTP 404",
                    status: 404,
                  }),
                }),
              ),
          },
          transport: {
            login: unusedLogin,
            getUpdates: () => Effect.succeed({}),
            startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
            stopTyping: () => Effect.void,
            notifyStart: () => Effect.void,
            notifyStop: () => Effect.void,
            downloadImage: () => Effect.die("unused"),
            sendText: (_auth, _to, text, _context, clientId) =>
              Effect.sync(() => {
                replies.push(text);
                return { serverMessageId: String(++outboundSequence), clientId };
              }),
          },
        },
      );
      expect(replies).toEqual(["引用对应的 Pi 会话已不可用。请取消引用后发送到默认会话。"]);
      expect(yield* store.routes.resolve("bot", String(outboundSequence))).toBe("deleted-session");
    }),
  ),
);

it.effect("messages from an unbound user are acknowledged without reaching Pi", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      let prompted = false;
      let replied = false;
      yield* processUpdateBatch(
        {
          get_updates_buf: "cursor-unauthorized",
          msgs: [
            {
              message_type: 1,
              from_user_id: "other-user",
              item_list: [{ type: 1, text_item: { text: "hello" } }],
            },
          ],
        },
        {
          store,
          gateway: {
            promptAndWait: () =>
              Effect.sync(() => {
                prompted = true;
                return "";
              }),
          },
          transport: {
            login: unusedLogin,
            getUpdates: () => Effect.succeed({}),
            startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
            stopTyping: () => Effect.void,
            notifyStart: () => Effect.void,
            notifyStop: () => Effect.void,
            downloadImage: () => Effect.die("unused image download"),
            sendText: () =>
              Effect.sync(() => {
                replied = true;
                return {
                  serverMessageId: String(++outboundSequence),
                  clientId: `client-${outboundSequence}`,
                };
              }),
          },
        },
      );

      const state = yield* store.read;
      expect(prompted).toBe(false);
      expect(replied).toBe(false);
      expect(state.cursor).toBe("cursor-unauthorized");
      expect(state.processedMessageIds).toHaveLength(1);
    }),
  ),
);

it.effect("stale credentials from typing stop the batch before Pi is prompted", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      let prompted = false;
      const result = yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: 43,
              message_type: 1,
              from_user_id: "allowed-user",
              context_token: "context",
              item_list: [{ type: 1, text_item: { text: "hello" } }],
            },
          ],
        },
        {
          store,
          gateway: {
            promptAndWait: () =>
              Effect.sync(() => {
                prompted = true;
                return "reply";
              }),
          },
          transport: {
            login: unusedLogin,
            getUpdates: () => Effect.succeed({}),
            startTyping: () =>
              Effect.fail(
                new IlinkSessionExpiredError({
                  operation: "ilink.get_config",
                  code: -14,
                  cause: "expired",
                }),
              ),
            stopTyping: () => Effect.void,
            notifyStart: () => Effect.void,
            notifyStop: () => Effect.void,
            downloadImage: () => Effect.die("unused image download"),
            sendText: (_auth, _to, _text, _context, clientId) => outboundReceipt(clientId),
          },
        },
      ).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(prompted).toBe(false);
    }),
  ),
);

it.effect(
  "idempotency conflicts become a terminal user-visible reply instead of a retry loop",
  () =>
    withTestStore((store) =>
      Effect.gen(function* () {
        yield* configureStore(store);
        const replies: string[] = [];
        yield* processUpdateBatch(
          {
            msgs: [
              {
                message_id: 44,
                message_type: 1,
                from_user_id: "allowed-user",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
          },
          {
            store,
            gateway: {
              promptAndWait: (_sessionId, requestId) =>
                Effect.fail(
                  new GatewayIdempotencyConflictError({
                    sessionId: "pi-session",
                    requestId,
                    reason: "InDoubt",
                  }),
                ),
            },
            transport: {
              login: unusedLogin,
              getUpdates: () => Effect.succeed({}),
              startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
              stopTyping: () => Effect.void,
              notifyStart: () => Effect.void,
              notifyStop: () => Effect.void,
              downloadImage: () => Effect.die("unused image download"),
              sendText: (_auth, _to, text, _context, clientId) =>
                Effect.sync(() => {
                  replies.push(text);
                  return { serverMessageId: String(++outboundSequence), clientId };
                }),
            },
          },
        );

        expect(replies).toEqual([
          "上一条请求的执行状态无法安全确认。为避免重复执行，已停止自动重试；请检查 Pi 会话后重新发送。",
        ]);
        expect((yield* store.read).processedMessageIds).toContain("message-44");
      }),
    ),
);

it.effect("text flushes all collected and inline images as one deterministic batch", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{
        requestId: string;
        message: string;
        images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
      }> = [];
      const replies: string[] = [];
      const gateway: PiGateway = {
        promptAndWait: (_sessionId, requestId, message, images) =>
          Effect.sync(() => {
            prompts.push({ requestId, message, images });
            return "完成";
          }),
      };
      const transport: WeixinTransport = {
        login: unusedLogin,
        getUpdates: () => Effect.succeed({}),
        startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
        stopTyping: () => Effect.void,
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: (image) =>
          Effect.succeed({
            data: image.media?.encrypt_query_param ?? "missing",
            mimeType: "image/png",
          }),
        sendText: (_auth, _to, text, _context, clientId) =>
          Effect.sync(() => {
            replies.push(text);
            return { serverMessageId: String(++outboundSequence), clientId };
          }),
      };

      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: 45,
              message_type: 1,
              from_user_id: "allowed-user",
              item_list: [
                { type: 2, image_item: { media: { encrypt_query_param: "image-only" } } },
              ],
            },
            {
              message_id: 46,
              message_type: 1,
              from_user_id: "allowed-user",
              item_list: [
                { type: 1, text_item: { text: "描述图片" } },
                { type: 2, image_item: { media: { encrypt_query_param: "mixed" } } },
              ],
            },
          ],
        },
        { store, transport, gateway },
      );

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        message: "描述图片",
        images: [
          { data: "image-only", mimeType: "image/png" },
          { data: "mixed", mimeType: "image/png" },
        ],
      });
      expect(prompts[0]?.requestId).toMatch(/^batch-[a-f0-9]{64}$/);
      expect(replies).toEqual(["完成"]);
    }),
  ),
);

it.effect("a single image waits 30 seconds and then uses the exact default prompt", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }> = [];
      const dependencies = imageDependencies(store, prompts);

      yield* processUpdateBatch({ msgs: [imageMessage(50, "one")] }, dependencies);
      expect(prompts).toEqual([]);
      yield* TestClock.adjust("29999 millis");
      yield* processUpdateBatch({}, dependencies);
      expect(prompts).toEqual([]);
      yield* TestClock.adjust("1 millis");
      yield* processUpdateBatch({}, dependencies);

      expect(prompts).toEqual([{ message: "请分析图片。", images: [{ data: "one" }] }]);
      expect((yield* store.read).pendingImageBatch).toBeUndefined();
    }),
  ),
);

it.effect("each additional image resets the sliding deadline", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }> = [];
      const dependencies = imageDependencies(store, prompts);

      yield* processUpdateBatch({ msgs: [imageMessage(51, "first")] }, dependencies);
      yield* TestClock.adjust("29 seconds");
      yield* processUpdateBatch({ msgs: [imageMessage(52, "second")] }, dependencies);
      yield* TestClock.adjust("29 seconds");
      yield* processUpdateBatch({}, dependencies);
      expect(prompts).toEqual([]);
      yield* TestClock.adjust("1 second");
      yield* processUpdateBatch({}, dependencies);

      expect(prompts).toEqual([
        {
          message: "请分析这些图片。",
          images: [{ data: "first" }, { data: "second" }],
        },
      ]);
    }),
  ),
);

it.effect("a Weixin voice transcript flushes the pending image as its description", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }> = [];
      const dependencies = imageDependencies(store, prompts);

      yield* processUpdateBatch({ msgs: [imageMessage(53, "voice-image")] }, dependencies);
      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: 54,
              message_type: 1,
              from_user_id: "allowed-user",
              item_list: [{ type: 3, voice_item: { text: "这是补充说明" } }],
            },
          ],
        },
        dependencies,
      );

      expect(prompts).toEqual([{ message: "这是补充说明", images: [{ data: "voice-image" }] }]);
    }),
  ),
);

it.effect("an overdue collecting batch resumes from the persisted state after restart", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }> = [];
      yield* processUpdateBatch(
        { msgs: [imageMessage(55, "persisted")] },
        imageDependencies(store, prompts),
      );
      yield* TestClock.adjust("30 seconds");

      const restartedStore = yield* makeStateStore(store.path);
      yield* processUpdateBatch({}, imageDependencies(restartedStore, prompts));

      expect(prompts).toEqual([{ message: "请分析图片。", images: [{ data: "persisted" }] }]);
      expect((yield* restartedStore.read).pendingImageBatch).toBeUndefined();
    }),
  ),
);

it.effect("text at the deadline wins the single batch transition", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const prompts: Array<{ message: string; images: ReadonlyArray<{ data: string }> }> = [];
      const dependencies = imageDependencies(store, prompts);
      yield* processUpdateBatch({ msgs: [imageMessage(56, "race")] }, dependencies);
      yield* TestClock.adjust("30 seconds");

      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: 57,
              message_type: 1,
              from_user_id: "allowed-user",
              item_list: [{ type: 1, text_item: { text: "截止时说明" } }],
            },
          ],
        },
        dependencies,
      );

      expect(prompts).toEqual([{ message: "截止时说明", images: [{ data: "race" }] }]);
    }),
  ),
);

it("caps long polling at the remaining image deadline without allowing a zero timeout", () => {
  const pending = {
    _tag: "Collecting" as const,
    sessionId: "session",
    userId: "user",
    messageIds: ["message"],
    images: [],
    contextToken: "context",
    deadlineAt: 30_000,
  };
  expect(imageAwarePollTimeout(38_000, pending, 1_000)).toBe(29_000);
  expect(imageAwarePollTimeout(38_000, pending, 30_000)).toBe(1);
  expect(imageAwarePollTimeout(10_000, pending, 1_000)).toBe(10_000);
});

it.effect("permanent image errors reply once and become processed", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const replies: string[] = [];
      let prompted = false;
      const transport: WeixinTransport = {
        login: unusedLogin,
        getUpdates: () => Effect.succeed({}),
        startTyping: () => Effect.die("typing must not start"),
        stopTyping: () => Effect.die("typing must not stop"),
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: () =>
          Effect.fail(
            new IlinkMediaError({
              operation: "decrypt",
              reason: "InvalidKey",
              cause: "bad key",
            }),
          ),
        sendText: (_auth, _to, text, _context, clientId) =>
          Effect.sync(() => {
            replies.push(text);
            return { serverMessageId: String(++outboundSequence), clientId };
          }),
      };
      const gateway: PiGateway = {
        promptAndWait: () =>
          Effect.sync(() => {
            prompted = true;
            return "unexpected";
          }),
      };
      const response = {
        msgs: [
          {
            message_id: 47,
            message_type: 1,
            from_user_id: "allowed-user",
            item_list: [{ type: 2, image_item: { aeskey: "bad" } }],
          },
        ],
      };

      yield* processUpdateBatch(response, { store, transport, gateway });
      yield* TestClock.adjust("30 seconds");
      yield* processUpdateBatch(response, { store, transport, gateway });

      expect(prompted).toBe(false);
      expect(replies).toEqual(["图片下载或解密失败，请重新发送原图。"]);
      expect((yield* store.read).processedMessageIds).toContain("message-47");
    }),
  ),
);

it.effect("transient image download failures preserve Dispatching for retry", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      let replied = false;
      const dependencies = {
        store,
        gateway: { promptAndWait: () => Effect.die("Pi must not be prompted") },
        transport: {
          login: unusedLogin,
          getUpdates: () => Effect.succeed({}),
          startTyping: () => Effect.die("typing must not start"),
          stopTyping: () => Effect.die("typing must not stop"),
          notifyStart: () => Effect.void,
          notifyStop: () => Effect.void,
          downloadImage: () =>
            Effect.fail(
              new HttpRequestError({
                operation: "ilink.download_image",
                url: "https://novac2c.cdn.weixin.qq.com/c2c/download",
                cause: "connection reset",
              }),
            ),
          sendText: (_auth, _to, _text, _context, clientId) =>
            Effect.sync(() => {
              replied = true;
              return { serverMessageId: String(++outboundSequence), clientId };
            }),
        },
      } satisfies { store: typeof store; gateway: PiGateway; transport: WeixinTransport };
      yield* processUpdateBatch(
        {
          msgs: [
            {
              message_id: 48,
              message_type: 1,
              from_user_id: "allowed-user",
              item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "retry" } } }],
            },
          ],
        },
        dependencies,
      );
      yield* TestClock.adjust("30 seconds");
      const result = yield* processUpdateBatch({}, dependencies).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(replied).toBe(false);
      const state = yield* store.read;
      expect(state.processedMessageIds).toContain("message-48");
      expect(state.pendingImageBatch?._tag).toBe("Dispatching");
      const requestId =
        state.pendingImageBatch?._tag === "Dispatching"
          ? state.pendingImageBatch.requestId
          : undefined;
      const retriedRequestIds: string[] = [];
      const recovered = imageDependencies(store, []);
      yield* processUpdateBatch(
        {},
        {
          ...recovered,
          gateway: {
            promptAndWait: (_sessionId, retriedRequestId) =>
              Effect.sync(() => {
                retriedRequestIds.push(retriedRequestId);
                return "恢复成功";
              }),
          },
        },
      );
      expect(retriedRequestIds).toEqual([requestId]);
      expect((yield* store.read).pendingImageBatch).toBeUndefined();
    }),
  ),
);

it.effect("untranscribed Weixin voice gets one friendly terminal reply", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* configureStore(store);
      const replies: string[] = [];
      let prompted = false;
      const response = {
        msgs: [
          {
            message_id: 49,
            message_type: 1,
            from_user_id: "allowed-user",
            item_list: [{ type: 3, voice_item: { media: {} } }],
          },
        ],
      };
      const transport: WeixinTransport = {
        login: unusedLogin,
        getUpdates: () => Effect.succeed({}),
        startTyping: () => Effect.die("typing must not start"),
        stopTyping: () => Effect.die("typing must not stop"),
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: () => Effect.die("image download must not start"),
        sendText: (_auth, _to, text, _context, clientId) =>
          Effect.sync(() => {
            replies.push(text);
            return { serverMessageId: String(++outboundSequence), clientId };
          }),
      };
      const gateway: PiGateway = {
        promptAndWait: () =>
          Effect.sync(() => {
            prompted = true;
            return "unexpected";
          }),
      };

      yield* processUpdateBatch(response, { store, transport, gateway });
      yield* processUpdateBatch(response, { store, transport, gateway });

      expect(prompted).toBe(false);
      expect(replies).toEqual(["微信暂时没能识别这条语音，请重新发送语音，或直接发送文字。"]);
      expect((yield* store.read).processedMessageIds).toContain("message-49");
    }),
  ),
);
