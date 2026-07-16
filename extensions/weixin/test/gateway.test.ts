import { expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { HttpRequestError } from "../src/errors.ts";
import { DEFAULT_PI_WEB_BASE_URL, makePiGateway } from "../src/gateway.ts";
import type { JsonHttpClient, JsonHttpRequest } from "../src/http.ts";

it("uses the address-family-neutral loopback hostname by default", () => {
  expect(DEFAULT_PI_WEB_BASE_URL).toBe("http://localhost:30141");
});

it.effect("gateway submits a blocking prompt to the loopback pi-web host", () =>
  Effect.gen(function* () {
    let captured: JsonHttpRequest | undefined;
    const http: JsonHttpClient = {
      request: () => Effect.die("unused JSON request"),
      stream: (request) =>
        Stream.unwrap(
          Effect.sync(() => {
            captured = request;
            return Stream.make(
              {
                _tag: "ToolStarted",
                runId: "run-1",
                toolCallId: "tool-1",
                toolName: "browser",
              },
              { _tag: "Completed", runId: "run-1", text: "reply" },
            );
          }),
        ),
      bytes: () => Effect.die("unused byte request"),
    };
    const gateway = yield* makePiGateway(http, "http://127.0.0.1:30141");
    const progress: string[] = [];
    const image = { data: "aGVsbG8=", mimeType: "image/png" };
    const reply = yield* gateway.promptAndWait(
      "session/id",
      "message-42",
      "hello",
      [image],
      (event) => Effect.sync(() => progress.push(event.toolName)),
    );

    expect(reply).toBe("reply");
    expect(progress).toEqual(["browser"]);
    expect(captured?.url).toBe(
      "http://127.0.0.1:30141/api/sessions/session%2Fid/actions/prompt-progress",
    );
    expect(captured?.headers?.["Origin"]).toBe("http://127.0.0.1:30141");
    expect(captured?.body).toEqual({
      requestId: "message-42",
      message: "hello",
      images: [{ type: "image", ...image }],
    });
  }),
);

it.effect("gateway rejects non-loopback hosts", () =>
  Effect.gen(function* () {
    const result = yield* makePiGateway(
      {
        request: () => Effect.succeed({}),
        stream: () => Stream.empty,
        bytes: () => Effect.die("unused byte request"),
      },
      "https://example.com",
    ).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
  }),
);

it.effect("gateway preserves pi-web idempotency conflicts as a typed terminal outcome", () =>
  Effect.gen(function* () {
    const gateway = yield* makePiGateway(
      {
        request: () => Effect.die("unused JSON request"),
        stream: (request) =>
          Stream.fail(
            new HttpRequestError({
              operation: request.operation,
              url: request.url,
              cause: "HTTP 409",
              status: 409,
              responseBody: {
                _tag: "Conflict",
                detail: {
                  _tag: "IdempotencyConflict",
                  requestId: "message-42",
                  reason: "InDoubt",
                },
              },
            }),
          ),
        bytes: () => Effect.die("unused byte request"),
      },
      "http://127.0.0.1:30141",
    );
    const error = yield* gateway
      .promptAndWait("session", "message-42", "hello", [], () => Effect.void)
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "GatewayIdempotencyConflictError",
      requestId: "message-42",
      reason: "InDoubt",
    });
  }),
);
