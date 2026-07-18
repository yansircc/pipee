import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeJsonHttpClient } from "../src/http.ts";

const responseClient = (...chunks: ReadonlyArray<Uint8Array>) =>
  HttpClient.make((request) =>
    Effect.succeed({
      request,
      status: 200,
      headers: {},
      stream: Stream.fromIterable(chunks),
    } as unknown as HttpClientResponse.HttpClientResponse),
  );

const jsonResponseClient = (body: string) =>
  HttpClient.make((request) =>
    Effect.succeed({
      request,
      status: 200,
      headers: {},
      stream: Stream.succeed(new TextEncoder().encode(body)),
      text: Effect.succeed(body),
    } as unknown as HttpClientResponse.HttpClientResponse),
  );

it.effect("preserves 64-bit JSON identifiers as decimal strings", () =>
  Effect.gen(function* () {
    const http = makeJsonHttpClient(
      jsonResponseClient('{"ret":0,"message_id":7483914874329324552}'),
    );
    const body = (yield* http.request({
      operation: "test.lossless",
      method: "GET",
      url: "https://example.test/message",
    })) as { readonly ret: number; readonly message_id: string };
    expect(body).toEqual({ ret: 0, message_id: "7483914874329324552" });
  }),
);

it.effect("collects byte streams in wire order", () =>
  Effect.gen(function* () {
    const http = makeJsonHttpClient(
      responseClient(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])),
    );
    const bytes = yield* http.bytes(
      { operation: "test.bytes", method: "GET", url: "https://example.test/data" },
      5,
    );
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  }),
);

it.effect("fails while streaming as soon as the byte limit is exceeded", () =>
  Effect.gen(function* () {
    const http = makeJsonHttpClient(
      responseClient(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
    );
    const error = yield* http
      .bytes({ operation: "test.bytes", method: "GET", url: "https://example.test/data" }, 5)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "HttpRequestError", operation: "test.bytes" });
  }),
);
