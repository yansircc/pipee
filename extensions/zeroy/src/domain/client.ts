import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data, Effect } from "effect";
import type { JsonRecord } from "./protocol.js";
import type { SiteConnection } from "./connection.js";

export class ZeroYConnectorError extends Data.TaggedError("ZeroYConnectorError")<{
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly data?: JsonRecord;
}> {}

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const connectorError = (
  payload: JsonRecord,
): { readonly message: string; readonly code?: string; readonly data?: JsonRecord } | undefined => {
  const error = asRecord(payload.error);
  if (!error || typeof error.message !== "string") return undefined;
  const data = asRecord(error.data);
  return {
    message: error.message,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(data === null ? {} : { data }),
  };
};

export const connectorCall = (
  connection: SiteConnection,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  draftOwnerId?: string,
): Effect.Effect<JsonRecord, ZeroYConnectorError> =>
  Effect.gen(function* () {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("x-zeroy-key", connection.connectionKey);
    if (draftOwnerId !== undefined) headers.set("x-zeroy-draft-owner", draftOwnerId);
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
      const connector = connectorError(payload);
      return yield* new ZeroYConnectorError({
        message:
          connector?.message ?? `${connection.label} rejected the request (${response.status}).`,
        status: response.status,
        ...(connector?.code === undefined ? {} : { code: connector.code }),
        ...(connector?.data === undefined ? {} : { data: connector.data }),
      });
    }
    return payload;
  }).pipe(
    Effect.withSpan("zeroy.connector.call", {
      attributes: {
        "zeroy.site_id": connection.siteId,
        "http.method": init.method ?? "GET",
        "http.route": `/wp-json/zeroy/v1/${path.split("?")[0] ?? ""}`,
      },
    }),
  );

export const connectorGet = (
  connection: SiteConnection,
  path: string,
  signal?: AbortSignal,
  draftOwnerId?: string,
) => connectorCall(connection, path, { method: "GET" }, signal, draftOwnerId);

export const connectorPost = (
  connection: SiteConnection,
  path: string,
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  draftOwnerId?: string,
) =>
  connectorCall(
    connection,
    path,
    { method: "POST", body: JSON.stringify(payload) },
    signal,
    draftOwnerId,
  );

/**
 * The Connector is remote. Successful HTTP is therefore insufficient: every
 * stable response boundary must prove its wire contract before it reaches a
 * tool result. Dynamic site facts remain inside their declared JsonValue
 * slots; this checks the stable envelope without creating a local shadow
 * model of a site's ThemeSchema or content.
 */
export const decodeConnectorPayload = <Schema extends TSchema>(
  contract: Schema,
  label: string,
  payload: JsonRecord,
): Effect.Effect<Static<Schema>, ZeroYConnectorError> =>
  Value.Check(contract, payload)
    ? Effect.succeed(payload as Static<Schema>)
    : Effect.fail(
        new ZeroYConnectorError({
          code: "zeroy_connector_response_invalid",
          message: `Connector returned an invalid ${label} response.`,
          data: {
            label,
            issues: [...Value.Errors(contract, payload)]
              .slice(0, 8)
              .map((issue) => ({ path: issue.path || "response", message: issue.message })),
          },
        }),
      );
