import { Effect, Schema, Stream } from "effect";
import {
  BridgeConfigurationError,
  GatewayError,
  GatewayIdempotencyConflictError,
  type HttpRequestError,
} from "./errors.ts";
import type { JsonHttpClient } from "./http.ts";
import type { ImageContent } from "./media.ts";
import { PiPromptProgressEventSchema, type PiToolProgress } from "./schema.ts";

export const DEFAULT_PI_WEB_BASE_URL = "http://localhost:30141";

export interface PiGateway {
  readonly promptAndWait: <E>(
    sessionId: string,
    requestId: string,
    message: string,
    images: ReadonlyArray<ImageContent>,
    onProgress: (event: PiToolProgress) => Effect.Effect<void, E>,
  ) => Effect.Effect<string, E | GatewayError | GatewayIdempotencyConflictError>;
}

const idempotencyConflict = (
  error: HttpRequestError,
): "PayloadMismatch" | "InDoubt" | undefined => {
  if (error.status !== 409 || typeof error.responseBody !== "object" || !error.responseBody) {
    return undefined;
  }
  const detail = (error.responseBody as { readonly detail?: unknown }).detail;
  if (typeof detail !== "object" || !detail) return undefined;
  const value = detail as { readonly _tag?: unknown; readonly reason?: unknown };
  return value._tag === "IdempotencyConflict" &&
    (value.reason === "PayloadMismatch" || value.reason === "InDoubt")
    ? value.reason
    : undefined;
};

const requireLoopbackBaseUrl = (input: string): Effect.Effect<URL, BridgeConfigurationError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input),
      catch: () => new BridgeConfigurationError({ reason: "PI_WEB_BASE_URL is not a valid URL" }),
    });
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "http:" || !loopback) {
      return yield* new BridgeConfigurationError({
        reason: "PI_WEB_BASE_URL must be an http loopback URL",
      });
    }
    return url;
  });

export const makePiGateway = (
  http: JsonHttpClient,
  baseUrl: string,
): Effect.Effect<PiGateway, BridgeConfigurationError> =>
  Effect.gen(function* () {
    const root = yield* requireLoopbackBaseUrl(baseUrl);
    return {
      promptAndWait: <E>(
        sessionId: string,
        requestId: string,
        message: string,
        images: ReadonlyArray<ImageContent>,
        onProgress: (event: PiToolProgress) => Effect.Effect<void, E>,
      ) =>
        Effect.gen(function* () {
          const endpoint = new URL(
            `/api/sessions/${encodeURIComponent(sessionId)}/actions/prompt-progress`,
            root,
          ).toString();
          const events = http
            .stream({
              operation: "pi.prompt_and_wait",
              method: "POST",
              url: endpoint,
              headers: {
                "Content-Type": "application/json",
                Origin: root.origin,
              },
              body: {
                requestId,
                message,
                ...(images.length > 0
                  ? {
                      images: images.map((image) => ({ type: "image" as const, ...image })),
                    }
                  : {}),
              },
            })
            .pipe(
              Stream.mapError((cause) => {
                const reason = idempotencyConflict(cause);
                return reason
                  ? new GatewayIdempotencyConflictError({ sessionId, requestId, reason })
                  : new GatewayError({ sessionId, cause });
              }),
              Stream.mapEffect((raw) =>
                Schema.decodeUnknownEffect(PiPromptProgressEventSchema)(raw).pipe(
                  Effect.mapError((cause) => new GatewayError({ sessionId, cause })),
                ),
              ),
            );
          const reply = yield* events.pipe(
            Stream.runFoldEffect(
              () => undefined as string | undefined,
              (current, event) =>
                event._tag === "Completed"
                  ? Effect.succeed(event.text)
                  : onProgress(event).pipe(Effect.map(() => current)),
            ),
          );
          if (reply === undefined) {
            return yield* new GatewayError({
              sessionId,
              cause: "Pi progress stream ended without a completion event",
            });
          }
          return reply || "（Pi 无文本回复）";
        }).pipe(Effect.withSpan("pi_weixin.gateway.prompt")),
    };
  });
