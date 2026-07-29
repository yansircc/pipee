import { Data, Effect } from "effect";
import type { JsonRecord } from "./protocol.js";
import type { SiteConnection } from "./connection.js";

export class ZeroYConnectorError extends Data.TaggedError("ZeroYConnectorError")<{
  readonly message: string;
}> {}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const connectorErrorMessage = (payload: JsonRecord): string | undefined => {
  const error = asRecord(payload.error);
  return error && typeof error.message === "string" ? error.message : undefined;
};

export const connectorCall = (
  connection: SiteConnection,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Effect.Effect<JsonRecord, ZeroYConnectorError> =>
  Effect.gen(function* () {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("x-zeroy-key", connection.connectionKey);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${connection.endpoint}/wp-json/zeroy/v1/${path}`, {
          ...init,
          headers,
          ...(signal === undefined ? {} : { signal }),
        }),
      catch: (cause) =>
        new ZeroYConnectorError({
          message: `Could not reach ${connection.label}: ${String(cause)}`,
        }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new ZeroYConnectorError({ message: `Could not read Connector response: ${String(cause)}` }),
    });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () =>
        new ZeroYConnectorError({
          message: `Connector returned invalid JSON: ${text.slice(0, 300)}`,
        }),
    });
    const payload = asRecord(parsed);
    if (payload === null) {
      return yield* new ZeroYConnectorError({
        message: "Connector returned a non-object JSON payload.",
      });
    }
    if (!response.ok) {
      return yield* new ZeroYConnectorError({
        message: `${connection.label} rejected the request (${response.status}): ${connectorErrorMessage(payload) ?? JSON.stringify(payload)}`,
      });
    }
    return payload;
  });

export const connectorGet = (connection: SiteConnection, path: string, signal?: AbortSignal) =>
  connectorCall(connection, path, { method: "GET" }, signal);

export const connectorPost = (
  connection: SiteConnection,
  path: string,
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => connectorCall(connection, path, { method: "POST", body: JSON.stringify(payload) }, signal);
