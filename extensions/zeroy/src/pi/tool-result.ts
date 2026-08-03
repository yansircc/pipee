import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { withPresentation } from "@pipee/extension-kit";
import { Effect } from "effect";
import { ZeroYConnectionConfigError } from "../domain/connection.js";
import { ZeroYConnectorError } from "../domain/client.js";
import type {
  JsonRecord,
  ProviderSchemaProjectionError,
  ToolInputValidationError,
} from "../domain/protocol.js";
import { zeroYPresentation } from "./presentation.js";
import { run, ZeroYSessionUnavailable } from "./session.js";

export type ZeroYToolFailure =
  | ZeroYConnectorError
  | ZeroYConnectionConfigError
  | ZeroYSessionUnavailable
  | ProviderSchemaProjectionError
  | ToolInputValidationError;

const forbiddenAgentResultKeys = new Set([
  "fieldId",
  "sourceHash",
  "revision",
  "currentRevision",
  "expectedRevision",
  "overlay",
  "operationSummaries",
  "bytesBase64",
  "fileContent",
]);

export const agentResultBoundary = (
  value: unknown,
  maxBytes = 16 * 1024,
):
  | { readonly ok: true; readonly encoded: string }
  | { readonly ok: false; readonly reason: string } => {
  const visit = (entry: unknown, path: string): string | null => {
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index++) {
        const violation = visit(entry[index], `${path}[${index}]`);
        if (violation !== null) return violation;
      }
      return null;
    }
    if (typeof entry !== "object" || entry === null) return null;
    for (const [key, child] of Object.entries(entry)) {
      if (forbiddenAgentResultKeys.has(key)) return `${path}.${key}`;
      const violation = visit(child, `${path}.${key}`);
      if (violation !== null) return violation;
    }
    return null;
  };
  const violation = visit(value, "$");
  if (violation !== null) return { ok: false, reason: `forbidden internal field at ${violation}` };
  const encoded = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(encoded, "utf8");
  return bytes <= maxBytes
    ? { ok: true, encoded }
    : { ok: false, reason: `encoded result is ${bytes} bytes; limit is ${maxBytes}` };
};

export const text = (value: unknown): string => {
  const boundary = agentResultBoundary(value);
  return boundary.ok
    ? boundary.encoded
    : JSON.stringify(
        {
          error: {
            code: "zeroy_agent_result_boundary_failed",
            message: boundary.reason,
          },
        },
        null,
        2,
      );
};

export const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

export const asString = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;

export const asNumber = (record: JsonRecord | null, key: string): number =>
  typeof record?.[key] === "number" ? record[key] : 0;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const toolFailurePayload = (error: unknown): JsonRecord => {
  if (error instanceof ZeroYConnectorError) {
    const data = error.data === undefined ? undefined : agentResultBoundary(error.data, 8 * 1024);
    return {
      error: {
        code: error.code ?? "zeroy_connector_error",
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(data?.ok === true ? { data: error.data } : {}),
      },
    };
  }
  return {
    error: {
      code:
        typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag)
          : "zeroy_request_failed",
      message: errorMessage(error),
    },
  };
};

export const result = (
  content: string,
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  tone: "success" | "info" | "warning" | "danger" = "success",
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: content }],
  details: withPresentation({}, zeroYPresentation(title, summary, fields, tone)),
});

export const runTool = (
  effect: Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices>,
): Promise<AgentToolResult<unknown>> =>
  run(
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed(
          result(
            text(toolFailurePayload(error)),
            "zeroY Connector",
            "Request failed",
            [["Error", errorMessage(error)]],
            "danger",
          ),
        ),
      ),
    ),
  );
