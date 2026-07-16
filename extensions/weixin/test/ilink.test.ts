import { createCipheriv } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import packageMetadata from "../package.json" with { type: "json" };
import { makeIlinkClient, type LoginEvent } from "../src/ilink.ts";
import {
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_BOT_AGENT,
  ILINK_CHANNEL_VERSION,
  encodeIlinkClientVersion,
} from "../src/ilink-protocol.ts";
import type { JsonHttpClient, JsonHttpRequest } from "../src/http.ts";
import type { WeixinAuth } from "../src/schema.ts";

const expectedBotAgent = `pi-weixin/${packageMetadata.version}`;

const auth: WeixinAuth = {
  token: "known-token",
  baseUrl: "https://api.example.test",
  accountId: "bot-1",
  userId: "user-1",
  savedAt: "2026-07-15T00:00:00.000Z",
};

const sequentialHttp = (responses: ReadonlyArray<unknown>) => {
  const requests: JsonHttpRequest[] = [];
  let index = 0;
  const http: JsonHttpClient = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        const response = responses[index];
        index += 1;
        return response;
      }),
    stream: () => Stream.empty,
    bytes: () => Effect.die("unused byte request"),
  };
  return { http, requests };
};

const imageHttp = (bytes: Uint8Array) => {
  let requestedUrl: string | undefined;
  const http: JsonHttpClient = {
    request: () => Effect.die("unused JSON request"),
    stream: () => Stream.empty,
    bytes: (request) =>
      Effect.sync(() => {
        requestedUrl = request.url;
        return bytes;
      }),
  };
  return { http, requestedUrl: () => requestedUrl };
};

it.effect("derives iLink client metadata from the package version", () =>
  Effect.gen(function* () {
    expect(ILINK_APP_ID).toBe("bot");
    expect(ILINK_CHANNEL_VERSION).toBe("2.4.6");
    expect(ILINK_BOT_AGENT).toBe(expectedBotAgent);
    expect(yield* ILINK_APP_CLIENT_VERSION).toBe(0x0002_0406);
    expect(yield* encodeIlinkClientVersion("2.4.6")).toBe(0x0002_0406);
    expect((yield* encodeIlinkClientVersion("2.4").pipe(Effect.flip))._tag).toBe(
      "IlinkProtocolError",
    );
    expect((yield* encodeIlinkClientVersion("2.4.invalid").pipe(Effect.flip))._tag).toBe(
      "IlinkProtocolError",
    );
  }),
);

it.effect("implements redirect and pair-code login as one protocol state machine", () =>
  Effect.gen(function* () {
    const { http, requests } = sequentialHttp([
      { ret: 0, qrcode: "qr-1", qrcode_img_content: "https://weixin.test/qr-1" },
      { ret: 0, status: "scaned_but_redirect", redirect_host: "region.example.test" },
      { ret: 0, status: "need_verifycode" },
      {
        ret: 0,
        status: "confirmed",
        bot_token: "new-token",
        ilink_bot_id: "bot-2",
        ilink_user_id: "user-2",
        baseurl: "https://messages.example.test",
      },
    ]);
    const events: LoginEvent[] = [];
    const client = makeIlinkClient(http);
    const result = yield* client.login(
      {
        onQr: () => Effect.void,
        onEvent: (event) => Effect.sync(() => events.push(event)),
        requestVerifyCode: () => Effect.succeed("123456"),
      },
      auth,
    );

    expect(result.token).toBe("new-token");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toEqual({ local_token_list: ["known-token"] });
    expect(requests[1]?.headers?.["iLink-App-Id"]).toBe("bot");
    expect(requests[2]?.url).toContain("https://region.example.test/");
    expect(requests[3]?.url).toContain("verify_code=123456");
    expect(events.map((event) => event._tag)).toEqual([
      "AwaitingScan",
      "Redirected",
      "AwaitingVerifyCode",
    ]);
  }),
);

it.effect("rejects redirect values that are not bare hosts", () =>
  Effect.gen(function* () {
    const { http } = sequentialHttp([
      { ret: 0, qrcode: "qr-1", qrcode_img_content: "https://weixin.test/qr-1" },
      { ret: 0, status: "scaned_but_redirect", redirect_host: "region.example.test/path" },
    ]);
    const error = yield* makeIlinkClient(http)
      .login({
        onQr: () => Effect.void,
        onEvent: () => Effect.void,
        requestVerifyCode: () => Effect.succeed("123456"),
      })
      .pipe(Effect.flip);

    expect(error._tag).toBe("IlinkProtocolError");
  }),
);

it.effect("treats errcode -14 as a stale credential, not a generic protocol failure", () =>
  Effect.gen(function* () {
    const { http } = sequentialHttp([
      { ret: 0, errcode: -14, errmsg: "token expired", msgs: [], get_updates_buf: "" },
    ]);
    const error = yield* makeIlinkClient(http).getUpdates(auth, "cursor", 38_000).pipe(Effect.flip);
    expect(error._tag).toBe("IlinkSessionExpiredError");
  }),
);

it.effect("uses the shared request algebra for polling, typing, and presence", () =>
  Effect.gen(function* () {
    const { http, requests } = sequentialHttp([
      { ret: 0, msgs: [], get_updates_buf: "next", longpolling_timeout_ms: 35_000 },
      { ret: 0, typing_ticket: "ticket-1" },
      { ret: 0 },
      { ret: 0 },
      { ret: 0 },
      { ret: 0 },
    ]);
    const client = makeIlinkClient(http);
    const updates = yield* client.getUpdates(auth, "cursor", 38_000);
    const typing = yield* client.startTyping(auth, "user-1", "context-1");
    yield* client.stopTyping(auth, typing);
    yield* client.notifyStart(auth);
    yield* client.notifyStop(auth);

    expect(updates.longpolling_timeout_ms).toBe(35_000);
    expect(requests.map((request) => request.url.split("/").slice(-1)[0])).toEqual([
      "getupdates",
      "getconfig",
      "sendtyping",
      "sendtyping",
      "notifystart",
      "notifystop",
    ]);
    expect(requests[0]?.body).toEqual({
      get_updates_buf: "cursor",
      base_info: { channel_version: "2.4.6", bot_agent: expectedBotAgent },
    });
    expect(requests[2]?.body).toMatchObject({ status: 1 });
    expect(requests[3]?.body).toMatchObject({ status: 2 });
  }),
);

it.effect("downloads and decrypts AES-128-ECB image media", () =>
  Effect.gen(function* () {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
    const fixture = imageHttp(encrypted);

    const image = yield* makeIlinkClient(fixture.http).downloadImage({
      aeskey: key.toString("hex"),
      media: { encrypt_query_param: "signed/image/reference" },
    });

    expect(image).toEqual({ data: png.toString("base64"), mimeType: "image/png" });
    expect(fixture.requestedUrl()).toContain("encrypted_query_param=signed%2Fimage%2Freference");
  }),
);

it.effect("accepts unencrypted image media when the protocol omits an AES key", () =>
  Effect.gen(function* () {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const fixture = imageHttp(jpeg);
    const image = yield* makeIlinkClient(fixture.http).downloadImage({
      media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/plain.jpg" },
    });

    expect(image).toEqual({ data: jpeg.toString("base64"), mimeType: "image/jpeg" });
  }),
);

it.effect("rejects invalid image keys and non-Weixin full URLs", () =>
  Effect.gen(function* () {
    const fixture = imageHttp(Buffer.from([]));
    const client = makeIlinkClient(fixture.http);
    const invalidKey = yield* client
      .downloadImage({
        aeskey: "not-a-key",
        media: { encrypt_query_param: "reference" },
      })
      .pipe(Effect.flip);
    const invalidUrl = yield* client
      .downloadImage({ media: { full_url: "https://example.com/image.png" } })
      .pipe(Effect.flip);

    expect(invalidKey).toMatchObject({ _tag: "IlinkMediaError", reason: "InvalidKey" });
    expect(invalidUrl).toMatchObject({
      _tag: "IlinkMediaError",
      reason: "InvalidReference",
    });
  }),
);
