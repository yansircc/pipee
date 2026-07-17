import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import {
  ATOMIC_TOOL_DESCRIPTORS,
  ATOMIC_TOOL_PROFILES,
  type AtomicToolProfile,
} from "../protocol/operation-contract.js";
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

export type AdvancedChromeProfile = Exclude<AtomicToolProfile, "core">;

type EnableProfile = (
  profile: AdvancedChromeProfile,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => Promise<ToolResult>;
type ReadStatus = (
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => Promise<ToolResult>;

const CHROME_ENABLE_TOOL_NAME = "chrome_enable";
const CHROME_STATUS_TOOL_NAME = "chrome_status";
export const CHROME_ATOMIC_TOOL_NAMES = ATOMIC_TOOL_DESCRIPTORS.map(({ name }) => name);
const CHROME_CORE_TOOL_NAMES = ATOMIC_TOOL_PROFILES.core;
export const CHROME_DEFAULT_TOOL_NAMES = [
  ...CHROME_CORE_TOOL_NAMES,
  CHROME_ENABLE_TOOL_NAME,
  CHROME_STATUS_TOOL_NAME,
];
export const CHROME_TOOL_NAMES = [
  ...CHROME_ATOMIC_TOOL_NAMES,
  CHROME_ENABLE_TOOL_NAME,
  CHROME_STATUS_TOOL_NAME,
];

const CHROME_TOOL_NAME_SET = new Set<string>(CHROME_TOOL_NAMES);
const ADVANCED_PROFILES = (Object.keys(ATOMIC_TOOL_PROFILES) as Array<AtomicToolProfile>).filter(
  (profile): profile is AdvancedChromeProfile => profile !== "core",
);
const EnableParameters = Schema.Struct({
  profile: Schema.Literals(
    ADVANCED_PROFILES as [AdvancedChromeProfile, ...Array<AdvancedChromeProfile>],
  ),
});
const StatusParameters = Schema.Struct({});

const profileDescription = ADVANCED_PROFILES.map(
  (profile) => `${profile}: ${ATOMIC_TOOL_PROFILES[profile].join(", ")}`,
).join("; ");

const withoutChromeTools = (active: ReadonlyArray<string>): Array<string> =>
  active.filter((name) => !CHROME_TOOL_NAME_SET.has(name));

export const activateChromeTools = (active: ReadonlyArray<string>): Array<string> => [
  ...new Set([...withoutChromeTools(active), ...CHROME_DEFAULT_TOOL_NAMES]),
];

export const enableChromeProfile = (
  active: ReadonlyArray<string>,
  profile: AdvancedChromeProfile,
): Array<string> => [...new Set([...active, ...ATOMIC_TOOL_PROFILES[profile]])];

export const revokeChromeTools = (active: ReadonlyArray<string>): Array<string> =>
  withoutChromeTools(active);

export const registerChromeTools = (
  pi: ExtensionAPI,
  executeTool: ExecuteTool,
  enableProfile: EnableProfile,
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
    name: CHROME_ENABLE_TOOL_NAME,
    label: "Enable Chrome Capabilities",
    description: `Enable one advanced Chrome capability profile for this agent run. ${profileDescription}`,
    promptSnippet: "Enable advanced Chrome capabilities only when the task requires them.",
    parameters: toJsonSchema(EnableParameters),
    execute: (_id, parameters, signal, _onUpdate, context) => {
      const { profile } = parameters as {
        readonly profile: AdvancedChromeProfile;
      };
      return enableProfile(profile, signal, context);
    },
  });
  pi.registerTool({
    name: CHROME_STATUS_TOOL_NAME,
    label: "Inspect Chrome Status",
    description: "Read the local Chrome bridge and connector status without changing it.",
    parameters: toJsonSchema(StatusParameters),
    execute: (_id, _parameters, signal, _onUpdate, context) => readStatus(signal, context),
  });
};
