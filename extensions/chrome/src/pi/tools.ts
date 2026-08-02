import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ATOMIC_TOOL_DESCRIPTORS, EmptyToolParameters } from "../protocol/operation-contract.js";
import { toJsonSchema } from "../protocol/schema.js";

export type ToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Record<string, unknown>;
};

type ExecuteTool = (
  toolName: string,
  input: unknown,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => Promise<ToolResult>;

type ReadStatus = (
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => Promise<ToolResult>;

const CHROME_STATUS_TOOL_NAME = "chrome_status";
export const CHROME_ATOMIC_TOOL_NAMES = ATOMIC_TOOL_DESCRIPTORS.map(({ name }) => name);
export const CHROME_TOOL_NAMES = [...CHROME_ATOMIC_TOOL_NAMES, CHROME_STATUS_TOOL_NAME];

const StatusParameters = EmptyToolParameters;

export const registerChromeTools = (
  pi: ExtensionAPI,
  executeTool: ExecuteTool,
  readStatus: ReadStatus,
): void => {
  for (const descriptor of ATOMIC_TOOL_DESCRIPTORS) {
    pi.registerTool({
      name: descriptor.name,
      label: descriptor.label,
      description: descriptor.description,
      promptSnippet: descriptor.promptSnippet,
      parameters: toJsonSchema(descriptor.parameters),
      execute: (_id, input, signal, _onUpdate, context) =>
        executeTool(descriptor.name, input, signal, context),
    });
  }
  pi.registerTool({
    name: CHROME_STATUS_TOOL_NAME,
    label: "Inspect Chrome Status",
    description: "Read the Chrome bridge and connector status without changing it.",
    parameters: toJsonSchema(StatusParameters),
    execute: (_id, _parameters, signal, _onUpdate, context) => readStatus(signal, context),
  });
};
