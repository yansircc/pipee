import * as Effect from "effect/Effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BridgeOwnerUnreachable, BridgeUnavailable, ProtocolFailure } from "../core/errors.js";
import {
  BRIDGE_ALLOWED_METHODS,
  BRIDGE_ROUTES,
  OWNER_REQUEST_DEADLINE_MS,
  REQUEST_BODY_TOO_LARGE_STATUS,
  responseBodyLimitForRoute,
  type OwnerBridgeRouteName,
} from "../protocol/bridge-contract.js";
import {
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_REQUEST_HEADERS,
} from "../protocol/connector-auth.js";
import { EXTENSION_PACKAGE_ID } from "./extension-package.js";

export type OwnerResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
};

type RequestBodyTooLargeCause = {
  readonly _tag: "RequestBodyTooLarge";
  readonly status: number;
  readonly limitBytes: number;
  readonly receivedBytes: number;
};

type InvalidRequestTargetCause = {
  readonly _tag: "InvalidRequestTarget";
  readonly status: 400;
  readonly target: string;
};

const expectedOrigin = `chrome-extension://${EXTENSION_PACKAGE_ID}`;

export const readBody = (request: IncomingMessage, limitBytes: number) =>
  Number.isSafeInteger(limitBytes) && limitBytes >= 0
    ? Effect.callback<string, ProtocolFailure>((resume) => {
        const chunks: Array<Buffer> = [];
        let receivedBytes = 0;
        let finished = false;
        const ignoreDrainError = () => undefined;
        const detach = () => {
          request.off("data", onData);
          request.off("end", onEnd);
          request.off("error", onError);
        };
        const finish = (effect: Effect.Effect<string, ProtocolFailure>) => {
          if (finished) return;
          finished = true;
          detach();
          resume(effect);
        };
        const tooLarge = () =>
          new ProtocolFailure({
            message: `HTTP request body exceeds ${limitBytes} bytes`,
            cause: {
              _tag: "RequestBodyTooLarge",
              status: REQUEST_BODY_TOO_LARGE_STATUS,
              limitBytes,
              receivedBytes,
            } satisfies RequestBodyTooLargeCause,
          });
        const onData = (chunk: Buffer | string) => {
          const buffer = Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > limitBytes) {
            chunks.length = 0;
            finish(Effect.fail(tooLarge()));
            request.once("error", ignoreDrainError);
            request.resume();
            return;
          }
          chunks.push(buffer);
        };
        const onEnd = () => finish(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
        const onError = (cause: unknown) =>
          finish(Effect.fail(new ProtocolFailure({ message: "Failed to read HTTP body", cause })));
        request.on("data", onData);
        request.once("end", onEnd);
        request.once("error", onError);

        const declaredLength = Number(request.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
          receivedBytes = declaredLength;
          finish(Effect.fail(tooLarge()));
          request.once("error", ignoreDrainError);
          request.resume();
        }
        return Effect.sync(() => {
          finished = true;
          detach();
        });
      })
    : Effect.fail(
        new ProtocolFailure({
          message: "HTTP request body limit is invalid",
          cause: { limitBytes },
        }),
      );

export const requestFailureHttpStatus = (error: unknown, fallback: number): number => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "ProtocolFailure" ||
    !("cause" in error)
  )
    return fallback;
  const cause = error.cause as
    | Partial<RequestBodyTooLargeCause>
    | Partial<InvalidRequestTargetCause>
    | undefined;
  if (cause?._tag === "RequestBodyTooLarge" && cause.status === REQUEST_BODY_TOO_LARGE_STATUS) {
    return cause.status;
  }
  return cause?._tag === "InvalidRequestTarget" && cause.status === 400 ? cause.status : fallback;
};

export const parseBridgeRequestPath = (
  request: IncomingMessage,
  baseUrl: string,
): Effect.Effect<string, ProtocolFailure> =>
  Effect.try({
    try: () => new URL(request.url ?? "/", baseUrl).pathname,
    catch: (cause) =>
      new ProtocolFailure({
        message: "HTTP request target is malformed",
        cause: {
          _tag: "InvalidRequestTarget",
          status: 400,
          target: request.url ?? "",
          parseCause: cause,
        } satisfies InvalidRequestTargetCause & { readonly parseCause: unknown },
      }),
  });

export const hasExpectedExtensionOrigin = (request: IncomingMessage): boolean =>
  request.headers.origin === expectedOrigin;

export const isExpectedExtensionRequest = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  return (
    request.headers[CONNECTOR_EXTENSION_ID_HEADER] === EXTENSION_PACKAGE_ID &&
    (origin === undefined || origin === expectedOrigin)
  );
};

export const extensionHeaders = (request: IncomingMessage): Record<string, string> =>
  hasExpectedExtensionOrigin(request)
    ? {
        "access-control-allow-origin": expectedOrigin,
        "access-control-allow-methods": BRIDGE_ALLOWED_METHODS,
        "access-control-allow-headers": CONNECTOR_REQUEST_HEADERS,
        "access-control-allow-private-network": "true",
        vary: "origin",
      }
    : {};

export const isLocalProcessRequest = (request: IncomingMessage): boolean =>
  !request.headers.origin && !request.headers["sec-fetch-site"];

export const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Effect.Effect<void, ProtocolFailure> =>
  Effect.try({
    try: () => JSON.stringify(body),
    catch: (cause) =>
      new ProtocolFailure({ message: "Failed to serialize HTTP JSON response", cause }),
  }).pipe(
    Effect.flatMap((encoded) =>
      encoded === undefined
        ? Effect.fail(
            new ProtocolFailure({
              message: "HTTP JSON response did not serialize to a value",
              cause: body,
            }),
          )
        : Effect.try({
            try: () => {
              response.writeHead(status, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                ...headers,
              });
              response.end(encoded);
            },
            catch: (cause) =>
              new ProtocolFailure({ message: "Failed to write HTTP JSON response", cause }),
          }),
    ),
  );

const ownerResponseTooLarge = (limitBytes: number) =>
  new BridgeUnavailable({
    message: `Shared bridge owner response exceeds ${limitBytes} bytes`,
  });

const cancelResponseBody = (body: ReadableStream<Uint8Array>) =>
  Effect.tryPromise({
    try: () => body.cancel(),
    catch: (cause) =>
      new BridgeUnavailable({ message: "Failed to cancel shared bridge owner response", cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("pi-chrome failed to cancel owner response body", error.message),
    ),
  );

const readOwnerResponseText = (
  response: Response,
  limitBytes: number,
): Effect.Effect<string, BridgeUnavailable> => {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    const failure = new BridgeUnavailable({
      message: "Shared bridge owner response limit is invalid",
    });
    return response.body
      ? cancelResponseBody(response.body).pipe(Effect.andThen(Effect.fail(failure)))
      : Effect.fail(failure);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    const failure = ownerResponseTooLarge(limitBytes);
    return response.body
      ? cancelResponseBody(response.body).pipe(Effect.andThen(Effect.fail(failure)))
      : Effect.fail(failure);
  }
  if (!response.body) return Effect.succeed("");
  return Effect.callback<string, BridgeUnavailable>((resume) => {
    const reader = response.body!.getReader();
    const chunks: Array<Buffer> = [];
    let receivedBytes = 0;
    let finished = false;
    const finish = (effect: Effect.Effect<string, BridgeUnavailable>) => {
      if (finished) return;
      finished = true;
      resume(effect);
    };
    const read = (): void => {
      reader.read().then(
        ({ done, value }) => {
          if (finished) return;
          if (done) {
            finish(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
            return;
          }
          const chunk = Buffer.from(value);
          receivedBytes += chunk.byteLength;
          if (receivedBytes > limitBytes) {
            chunks.length = 0;
            const failure = ownerResponseTooLarge(limitBytes);
            reader.cancel().then(
              () => finish(Effect.fail(failure)),
              (cause) =>
                finish(
                  Effect.logWarning(
                    "pi-chrome failed to cancel oversized owner response",
                    String(cause),
                  ).pipe(Effect.andThen(Effect.fail(failure))),
                ),
            );
            return;
          }
          chunks.push(chunk);
          read();
        },
        (cause) =>
          finish(
            Effect.fail(
              new BridgeUnavailable({
                message: "Failed to read shared bridge owner response",
                cause,
              }),
            ),
          ),
      );
    };
    read();
    return Effect.sync(() => {
      finished = true;
    }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause) =>
            new BridgeUnavailable({ message: "Failed to cancel owner response reader", cause }),
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("pi-chrome failed to cancel owner response reader", error.message),
      ),
    );
  });
};

export const ownerRequest = (
  baseUrl: string,
  routeName: OwnerBridgeRouteName,
  init: Omit<RequestInit, "method">,
  timeoutMs: number = OWNER_REQUEST_DEADLINE_MS,
): Effect.Effect<OwnerResponse, BridgeUnavailable | BridgeOwnerUnreachable> => {
  const route = BRIDGE_ROUTES[routeName];
  return Effect.tryPromise({
    try: (signal) => fetch(`${baseUrl}${route.path}`, { ...init, method: route.method, signal }),
    catch: (cause) =>
      new BridgeOwnerUnreachable({ message: "Shared bridge owner is unreachable", cause }),
  }).pipe(
    Effect.flatMap((response) =>
      readOwnerResponseText(response, responseBodyLimitForRoute(routeName)).pipe(
        Effect.map((text) => ({ ok: response.ok, status: response.status, text })),
      ),
    ),
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new BridgeUnavailable({ message: "Timed out waiting for shared bridge owner" }),
        ),
    }),
  );
};

export const requireOwnerSuccess = (
  response: OwnerResponse,
): Effect.Effect<string, BridgeUnavailable> =>
  response.ok
    ? Effect.succeed(response.text)
    : Effect.fail(
        new BridgeUnavailable({
          message: `Shared bridge owner returned HTTP ${response.status}: ${response.text}`,
        }),
      );
