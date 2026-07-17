import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { decodeAtomicToolRequest, type DomainRequest } from "../protocol/codec.js";
import type { SessionContext } from "../protocol/schema.js";
import { bridgeDeliveryTimeoutMs } from "../protocol/timeout.js";
import { formatInputResult, formatPageResult, json } from "./format.js";
import { saveScreenshot } from "./screenshot.js";
import type { ToolResult } from "./tools.js";

export type ChromeToolScope = Readonly<{
  context: ExtensionContext;
  identity: Readonly<{ key: string; groupTitle: string }>;
}>;

type ToolAdmission<Claim> = Readonly<{
  scope: ChromeToolScope;
  claim: Claim;
}>;

type ToolExecutionPort<
  Claim extends { readonly background: boolean },
  AdmissionError,
  E,
  R,
> = Readonly<{
  admit: (context: ExtensionContext) => Effect.Effect<ToolAdmission<Claim>, AdmissionError>;
  send: (
    claim: Claim,
    request: DomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ) => Effect.Effect<unknown, E, R>;
}>;

const workspaceCwd = (context: ExtensionContext): string => context.cwd || process.cwd();

const normalizeRequest = (request: DomainRequest, context: ExtensionContext) =>
  Effect.gen(function* () {
    if (request.domain !== "input" || request.call.operation.kind !== "upload") return request;
    const path = yield* Path.Path;
    const operation = request.call.operation;
    return {
      domain: "input" as const,
      call: {
        ...request.call,
        operation: {
          ...operation,
          paths: operation.paths.map((value) => path.resolve(workspaceCwd(context), value)),
        },
      },
    } satisfies DomainRequest;
  });

const sessionFor = (
  scope: ChromeToolScope,
  request: DomainRequest,
  defaultBackground: boolean,
): SessionContext => {
  const call = request.call;
  const background =
    "background" in call && typeof call.background === "boolean"
      ? call.background
      : defaultBackground;
  return { ...scope.identity, foreground: !background };
};

const projectToolResult = (request: DomainRequest, value: unknown, scope: ChromeToolScope) =>
  Effect.gen(function* () {
    if (request.domain === "page") {
      const operation = request.call.operation;
      if (operation.kind === "screenshot") {
        const saved = yield* saveScreenshot(workspaceCwd(scope.context), operation, value);
        return {
          content: [{ type: "text" as const, text: saved.text }],
          details: { value: saved.value },
        } satisfies ToolResult;
      }
      return {
        content: [{ type: "text" as const, text: formatPageResult(request.call, value) }],
        details: { value },
      } satisfies ToolResult;
    }
    if (request.domain === "input") {
      return {
        content: [{ type: "text" as const, text: formatInputResult(request.call, value) }],
        details: { value },
      } satisfies ToolResult;
    }
    return {
      content: [{ type: "text" as const, text: json(value) }],
      details: { value },
    } satisfies ToolResult;
  });

export const executeChromeTool = <
  Claim extends { readonly background: boolean },
  AdmissionError,
  E,
  R,
>(
  port: ToolExecutionPort<Claim, AdmissionError, E, R>,
  toolName: string,
  input: unknown,
  context: ExtensionContext,
) =>
  Effect.gen(function* () {
    const { scope, claim } = yield* port.admit(context);
    const decoded = yield* decodeAtomicToolRequest(toolName, input);
    const request = yield* normalizeRequest(decoded, scope.context);
    const session = sessionFor(scope, request, claim.background);
    const value = yield* port.send(claim, request, session, bridgeDeliveryTimeoutMs(request));
    return yield* projectToolResult(request, value, scope);
  });
