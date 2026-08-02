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

export const text = (value: unknown): string => JSON.stringify(value, null, 2);

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
    return {
      error: {
        code: error.code ?? "zeroy_connector_error",
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.data === undefined ? {} : { data: error.data }),
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
