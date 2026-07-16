import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  getPackageDir,
  ModelRegistry,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
  Theme,
  buildSessionContext as piBuildSessionContext,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent"
import { completeSimple, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat"
import {
  Context,
  Cause,
  Crypto,
  Data,
  Deferred,
  Effect,
  Encoding,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import {
  ActiveBashExecution,
  AgentMessage,
  ApiKeyProvider,
  ApiKeyStatus,
  CompletedBashExecution,
  ContextUsage,
  ExtensionStatusContribution,
  ExtensionUiProjection,
  ExtensionWidgetItem,
  JsonValue,
  ModelCatalog,
  ModelConfigValidation,
  ModelsConfig,
  ModelTestResult,
  OAuthEvent,
  OAuthProvider,
  PluginsResponse,
  QueuedMessages,
  RunId,
  RunScopedEvent,
  RuntimeEnvelope,
  RuntimeIdentity,
  SessionScopedEvent,
  RuntimeSnapshot,
  SessionEntry,
  SessionStats,
  SessionTreeNode,
  SkillsResponse,
  SlashCommand,
  ToolEntry,
  type ChromeControlRequestType,
  type ExtensionInteraction as ExtensionInteractionValue,
  type ExtensionInteractionAnswer as ExtensionInteractionAnswerValue,
  type ExtensionInteractionResponse as ExtensionInteractionResponseValue,
  type LoopControlRequestType,
  type PluginsResponse as PluginsResponseValue,
  type RuntimeEnvelope as RuntimeEnvelopeValue,
  type WeixinControlRequestType,
} from "@/api/contract"
import { appendLiveBashOutput } from "@/lib/bash-command"
import { extensionStructuredStatusOrUndefined } from "@/lib/extension-status"
import { decodeExtensionImageWidget } from "@/lib/extension-widget"
import {
  canonicalPromptInput,
  decidePromptRequest,
  PROMPT_REQUEST_ENTRY_TYPE,
  type PromptInput,
} from "./prompt-request"
import {
  DEFAULT_TOOL_PRESET,
  getToolNamesForPreset,
  mergeBuiltinSelectionWithActiveExtensions,
} from "@/lib/tool-presets"
import {
  PI_COMPANION_PACKAGE_NAMES,
  getPackageSource,
  isDisabledPackage,
  isLocalPackageSource,
  removeConfiguredPackage,
  setConfiguredPackageDisabled,
} from "@/lib/plugin-package-settings"

export class PiAdapterError extends Data.TaggedError("PiAdapterError")<{
  readonly operation: string
  readonly message: string
}> {}

export class PiPromptBusyError extends Data.TaggedError("PiPromptBusyError")<{
  readonly message: string
}> {}

export class PiPromptIdempotencyError extends Data.TaggedError("PiPromptIdempotencyError")<{
  readonly requestId: string
  readonly reason: "PayloadMismatch" | "InDoubt"
  readonly message: string
}> {}

export class PiInteractionConflictError extends Data.TaggedError("PiInteractionConflictError")<{
  readonly interactionId: string
}> {}

export class PiInteractionResponseError extends Data.TaggedError("PiInteractionResponseError")<{
  readonly interactionId: string
  readonly method: ExtensionInteractionValue["method"]
  readonly responseTag: ExtensionInteractionAnswerValue["_tag"]
}> {}

const adapterError = (operation: string) => (cause: unknown) =>
  new PiAdapterError({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

const decode = <S extends Schema.Top>(schema: S, operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new PiAdapterError({ operation, message: String(cause) })),
  )

export interface PiListedSession {
  readonly path: string
  readonly id: string
  readonly cwd: string
  readonly name?: string
  readonly created: string
  readonly modified: string
  readonly messageCount: number
  readonly firstMessage: string
  readonly parentSessionPath?: string
}

export interface PiSessionDocument {
  readonly filePath: string
  readonly id: string
  readonly cwd: string
  readonly name?: string
  readonly created: string
  readonly parentSessionPath?: string
  readonly leafId: string | null
  readonly entries: ReadonlyArray<typeof SessionEntry.Type>
  readonly tree: ReadonlyArray<SessionTreeNode>
  readonly thinkingLevel: string
  readonly model: { readonly provider: string; readonly modelId: string } | null
}

export interface PiRuntimeCreateOptions {
  readonly sessionFile: string | null
  readonly cwd: string
  readonly toolNames?: ReadonlyArray<string>
}

export interface PromptAndWaitResult {
  readonly runId: RunId
  readonly text: string
}

export interface PromptRequestHandle {
  readonly runId: RunId
  readonly completion: Effect.Effect<PromptAndWaitResult, PiAdapterError | PiPromptIdempotencyError>
}

export type PluginAction = "install" | "remove" | "update" | "disable" | "enable"
export type PluginScope = "global" | "project"

export interface PiRuntime {
  readonly sessionId: string
  readonly sessionFile: string
  readonly cwd: string
  readonly created: string
  readonly firstMessage: Effect.Effect<string | null>
  readonly isConversationEmpty: Effect.Effect<boolean>
  readonly events: PubSub.PubSub<RuntimeEnvelopeValue>
  readonly publishRunEvent: (event: typeof RunScopedEvent.Type) => void
  readonly snapshot: Effect.Effect<typeof RuntimeSnapshot.Type, PiAdapterError>
  readonly promptRequest: (
    runId: RunId,
    requestId: string,
    input: PromptInput,
  ) => Effect.Effect<PromptRequestHandle, PiAdapterError | PiPromptBusyError | PiPromptIdempotencyError>
  readonly steer: (message: string, images?: PromptInput["images"]) => Effect.Effect<void, PiAdapterError>
  readonly followUp: (message: string, images?: PromptInput["images"]) => Effect.Effect<void, PiAdapterError>
  readonly abort: Effect.Effect<void, PiAdapterError>
  readonly executeBash: (
    runId: RunId,
    id: string,
    command: string,
    excludeFromContext: boolean,
  ) => Effect.Effect<typeof CompletedBashExecution.Type, PiAdapterError>
  readonly abortBash: Effect.Effect<void, PiAdapterError>
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<{ readonly id: string; readonly provider: string }, PiAdapterError>
  readonly navigate: (targetId: string) => Effect.Effect<{ readonly cancelled: boolean }, PiAdapterError>
  readonly setThinkingLevel: (level: string) => Effect.Effect<void, PiAdapterError>
  readonly compact: (
    runId: RunId,
    instructions?: string,
  ) => Effect.Effect<
    {
      readonly tokensBefore?: number
      readonly estimatedTokensAfter?: number
    },
    PiAdapterError
  >
  readonly abortCompaction: Effect.Effect<void, PiAdapterError>
  readonly setSessionName: (name: string) => Effect.Effect<void, PiAdapterError>
  readonly stats: Effect.Effect<typeof SessionStats.Type, PiAdapterError>
  readonly lastAssistantText: Effect.Effect<string>
  readonly setAutoCompaction: (enabled: boolean) => Effect.Effect<void, PiAdapterError>
  readonly setAutoRetry: (enabled: boolean) => Effect.Effect<void, PiAdapterError>
  readonly clearQueue: Effect.Effect<typeof QueuedMessages.Type, PiAdapterError>
  readonly tools: Effect.Effect<ReadonlyArray<typeof ToolEntry.Type>, PiAdapterError>
  readonly commands: Effect.Effect<ReadonlyArray<typeof SlashCommand.Type>, PiAdapterError>
  readonly setTools: (toolNames: ReadonlyArray<string>) => Effect.Effect<void, PiAdapterError>
  readonly invokeSlashCommand: (name: string, args: string) => Effect.Effect<void, PiAdapterError>
  readonly controlLoop: (request: LoopControlRequestType) => Effect.Effect<void, PiAdapterError>
  readonly controlWeixin: (request: WeixinControlRequestType) => Effect.Effect<void, PiAdapterError>
  readonly controlChrome: (request: ChromeControlRequestType) => Effect.Effect<void, PiAdapterError>
  readonly resolveInteraction: (
    interactionId: string,
    response: ExtensionInteractionResponseValue,
  ) => Effect.Effect<void, PiInteractionConflictError | PiInteractionResponseError>
  readonly reload: Effect.Effect<void, PiAdapterError>
  readonly dispose: Effect.Effect<void>
}

export class PiAgentAdapter extends Context.Service<
  PiAgentAdapter,
  {
    readonly listSessions: Effect.Effect<ReadonlyArray<PiListedSession>, PiAdapterError>
    readonly readSession: (filePath: string) => Effect.Effect<PiSessionDocument, PiAdapterError>
    readonly appendSessionName: (filePath: string, name: string) => Effect.Effect<void, PiAdapterError>
    readonly createFork: (
      filePath: string,
      entryId: string,
    ) => Effect.Effect<
      {
        readonly cancelled: boolean
        readonly newSessionId?: string
        readonly newSessionFile?: string
      },
      PiAdapterError
    >
    readonly createRuntime: (
      options: PiRuntimeCreateOptions,
      identity: typeof RuntimeIdentity.Type,
    ) => Effect.Effect<PiRuntime, PiAdapterError, Scope.Scope>
    readonly exportHtml: (filePath: string) => Effect.Effect<string, PiAdapterError>
    readonly modelCatalog: (cwd: string) => Effect.Effect<typeof ModelCatalog.Type, PiAdapterError>
    readonly readModelsConfig: Effect.Effect<typeof ModelsConfig.Type, PiAdapterError>
    readonly validateModelsConfig: (
      value: typeof ModelsConfig.Type,
    ) => Effect.Effect<typeof ModelConfigValidation.Type, PiAdapterError>
    readonly saveModelsConfig: (value: typeof ModelsConfig.Type) => Effect.Effect<void, PiAdapterError>
    readonly testModelConfig: (
      providerName: string,
      provider: JsonValue,
      model: JsonValue,
    ) => Effect.Effect<typeof ModelTestResult.Type, PiAdapterError>
    readonly oauthProviders: Effect.Effect<ReadonlyArray<typeof OAuthProvider.Type>, PiAdapterError>
    readonly apiKeyProviders: Effect.Effect<ReadonlyArray<typeof ApiKeyProvider.Type>, PiAdapterError>
    readonly apiKeyStatus: (provider: string) => Effect.Effect<typeof ApiKeyStatus.Type, PiAdapterError>
    readonly setApiKey: (provider: string, apiKey: string) => Effect.Effect<void, PiAdapterError>
    readonly removeApiKey: (provider: string) => Effect.Effect<void, PiAdapterError>
    readonly oauthEvents: (
      provider: string,
    ) => Effect.Effect<Stream.Stream<typeof OAuthEvent.Type, PiAdapterError>, PiAdapterError>
    readonly submitOAuthInput: (provider: string, token: string, code: string) => Effect.Effect<void, PiAdapterError>
    readonly logout: (provider: string) => Effect.Effect<void, PiAdapterError>
    readonly plugins: (cwd: string) => Effect.Effect<PluginsResponseValue, PiAdapterError>
    readonly pluginAction: (
      cwd: string,
      action: PluginAction,
      source: string | undefined,
      scope: PluginScope | undefined,
    ) => Effect.Effect<PluginsResponseValue, PiAdapterError>
    readonly skills: (cwd: string) => Effect.Effect<typeof SkillsResponse.Type, PiAdapterError>
    readonly toggleSkill: (filePath: string, disabled: boolean) => Effect.Effect<void, PiAdapterError>
  }
>()("pi-web/server/PiAgentAdapter") {}

interface ModelLike {
  readonly id: string
  readonly provider: string
  readonly compat?: { readonly thinkingFormat?: string }
}

interface BashResultLike {
  readonly output: string
  readonly exitCode: number | undefined
  readonly cancelled: boolean
  readonly truncated: boolean
  readonly fullOutputPath?: string
}

interface AgentSessionLike {
  readonly sessionId: string
  readonly sessionFile?: string
  readonly isStreaming: boolean
  readonly isCompacting: boolean
  readonly isBashRunning: boolean
  readonly autoCompactionEnabled: boolean
  readonly autoRetryEnabled: boolean
  readonly model?: ModelLike
  readonly modelRegistry: { readonly find: (provider: string, modelId: string) => ModelLike | undefined }
  readonly sessionManager: SessionManager
  readonly agent: { readonly state?: { systemPrompt?: string; thinkingLevel?: string } }
  readonly extensionRunner: {
    readonly getRegisteredCommands: () => ReadonlyArray<{
      readonly invocationName: string
      readonly description?: string
      readonly sourceInfo: unknown
    }>
    readonly getCommand: (name: string) =>
      | {
          readonly handler: (args: string, context: unknown) => Promise<void>
        }
      | undefined
    readonly createCommandContext: () => unknown
    readonly emitUserBash: (event: {
      readonly type: "user_bash"
      readonly command: string
      readonly excludeFromContext: boolean
      readonly cwd: string
    }) => Promise<{ readonly operations?: unknown; readonly result?: BashResultLike } | undefined>
    readonly setUIContext?: (context?: unknown, mode?: "rpc") => void
  }
  readonly promptTemplates: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly sourceInfo: unknown
  }>
  readonly resourceLoader: {
    readonly getSkills: () => {
      readonly skills: ReadonlyArray<{
        readonly name: string
        readonly description?: string
        readonly sourceInfo: unknown
      }>
    }
  }
  readonly bindExtensions?: (bindings: {
    readonly uiContext?: unknown
    readonly mode?: "rpc"
    readonly commandContextActions?: unknown
    readonly shutdownHandler?: () => void
    readonly onError?: (error: {
      readonly extensionPath: string
      readonly event: string
      readonly error: string
    }) => void
  }) => Promise<void>
  readonly subscribe: (listener: (event: unknown) => void) => () => void
  readonly prompt: (
    text: string,
    options?: {
      readonly images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>
      readonly streamingBehavior?: "steer" | "followUp"
      readonly source?: "rpc"
      readonly preflightResult?: (accepted: boolean) => void
    },
  ) => Promise<void>
  readonly waitForIdle: () => Promise<void>
  readonly abort: () => Promise<void>
  readonly executeBash: (
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { readonly excludeFromContext?: boolean; readonly operations?: unknown },
  ) => Promise<BashResultLike>
  readonly recordBashResult: (
    command: string,
    result: BashResultLike,
    options?: { readonly excludeFromContext?: boolean },
  ) => void
  readonly abortBash: () => void
  readonly setModel: (model: ModelLike) => Promise<void>
  readonly navigateTree: (
    targetId: string,
    options?: { readonly summarize?: boolean },
  ) => Promise<{ readonly cancelled: boolean }>
  readonly setThinkingLevel: (level: string) => void
  readonly compact: (instructions?: string) => Promise<unknown>
  readonly setSessionName: (name: string) => void
  readonly getSessionStats: () => unknown
  readonly getLastAssistantText: () => string | undefined
  readonly steer: (message: string, images?: PromptInput["images"]) => Promise<void>
  readonly followUp: (message: string, images?: PromptInput["images"]) => Promise<void>
  readonly setAutoCompactionEnabled: (enabled: boolean) => void
  readonly setAutoRetryEnabled: (enabled: boolean) => void
  readonly pendingMessageCount: number
  readonly getSteeringMessages: () => ReadonlyArray<string>
  readonly getFollowUpMessages: () => ReadonlyArray<string>
  readonly clearQueue: () => { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
  readonly getAllTools: () => ReadonlyArray<{ readonly name: string; readonly description: string }>
  readonly getActiveToolNames: () => ReadonlyArray<string>
  readonly setActiveToolsByName: (names: ReadonlyArray<string>) => void
  readonly abortCompaction: () => void
  readonly getContextUsage: () => typeof ContextUsage.Type | undefined
  readonly reload: (options?: { readonly beforeSessionStart?: () => void | Promise<void> }) => Promise<void>
}

class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
      {} as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    )
  }
  override fg(...[, text]: Parameters<Theme["fg"]>): string {
    return text
  }
  override bg(...[, text]: Parameters<Theme["bg"]>): string {
    return text
  }
  override bold(text: string): string {
    return text
  }
  override italic(text: string): string {
    return text
  }
  override underline(text: string): string {
    return text
  }
  override inverse(text: string): string {
    return text
  }
  override strikethrough(text: string): string {
    return text
  }
  override getFgAnsi(): string {
    return ""
  }
  override getBgAnsi(): string {
    return ""
  }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => text
  }
}

const PLAIN_TEXT_THEME = new PlainTextTheme()

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const thinkingSuffixes = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const oauthProviderIds = new Set(["anthropic", "github-copilot", "openai-codex"])
const oauthDisplayNames: Readonly<Record<string, string>> = {
  "openai-codex": "ChatGPT Plus/Pro",
  "github-copilot": "GitHub Copilot",
}

const stripThinkingSuffix = (modelRef: string): string => {
  const trimmed = modelRef.trim()
  const colon = trimmed.lastIndexOf(":")
  if (colon === -1) return trimmed
  return thinkingSuffixes.has(trimmed.slice(colon + 1)) ? trimmed.slice(0, colon) : trimmed
}

const visibleModels = <T extends { readonly id: string; readonly provider: string }>(
  available: ReadonlyArray<T>,
  enabled: ReadonlyArray<string> | undefined,
): ReadonlyArray<T> => {
  if (enabled === undefined || enabled.length === 0) return available
  const references = new Set(enabled.map(stripThinkingSuffix).filter(Boolean))
  const visible = available.filter(
    (model) => references.has(`${model.provider}/${model.id}`) || references.has(model.id),
  )
  return visible.length === 0 ? available : visible
}

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface MutableResourceCounts {
  extensions: number
  skills: number
  prompts: number
  themes: number
}

interface PluginResourceValue {
  readonly kind: "extension" | "skill" | "prompt" | "theme"
  readonly name: string
  readonly path: string
  readonly relativePath: string
}

const emptyResourceCounts = (): MutableResourceCounts => ({
  extensions: 0,
  skills: 0,
  prompts: 0,
  themes: 0,
})

const pluginScope = (scope: string): PluginScope => (scope === "project" ? "project" : "global")
const pluginKey = (source: string, scope: PluginScope): string => `${scope}\0${source}`

const configuredVersion = (source: string): string | undefined => {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined
  if (npmSpec !== undefined) {
    const lastAt = npmSpec.lastIndexOf("@")
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0
    return lastAt > packageNameEnd ? npmSpec.slice(lastAt + 1) || undefined : undefined
  }
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@")
    if (lastAt > Math.max(source.lastIndexOf("/"), source.lastIndexOf(":"))) {
      return source.slice(lastAt + 1) || undefined
    }
  }
  return undefined
}

const resourceName = (path: Path.Path, resourcePath: string, kind: PluginResourceValue["kind"]): string => {
  const file = path.basename(resourcePath)
  const extension = path.extname(file)
  if (kind === "skill" && file.toLowerCase() === "skill.md") return path.basename(path.dirname(resourcePath))
  if (extension && (kind === "extension" || kind === "theme" || kind === "prompt")) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return path.basename(path.dirname(resourcePath))
    return file.slice(0, -extension.length)
  }
  return file
}

const collectPluginResources = (
  path: Path.Path,
  resolved: ResolvedPaths,
): {
  readonly counts: ReadonlyMap<string, MutableResourceCounts>
  readonly resources: ReadonlyMap<string, ReadonlyArray<PluginResourceValue>>
  readonly totals: MutableResourceCounts
} => {
  const counts = new Map<string, MutableResourceCounts>()
  const resources = new Map<string, Array<PluginResourceValue>>()
  const totals = emptyResourceCounts()
  const add = (
    resource: ResolvedResource,
    countKey: keyof MutableResourceCounts,
    kind: PluginResourceValue["kind"],
  ) => {
    if (!resource.enabled || resource.metadata.origin !== "package") return
    const scope = pluginScope(resource.metadata.scope)
    const key = pluginKey(resource.metadata.source, scope)
    const packageCounts = counts.get(key) ?? emptyResourceCounts()
    packageCounts[countKey] += 1
    totals[countKey] += 1
    counts.set(key, packageCounts)
    const packageResources = resources.get(key) ?? []
    const relative =
      resource.metadata.baseDir === undefined ? resource.path : path.relative(resource.metadata.baseDir, resource.path)
    packageResources.push({
      kind,
      name: resourceName(path, resource.path, kind),
      path: resource.path,
      relativePath: relative && !relative.startsWith("..") ? relative : resource.path,
    })
    resources.set(key, packageResources)
  }
  for (const resource of resolved.extensions) add(resource, "extensions", "extension")
  for (const resource of resolved.skills) add(resource, "skills", "skill")
  for (const resource of resolved.prompts) add(resource, "prompts", "prompt")
  for (const resource of resolved.themes) add(resource, "themes", "theme")
  return { counts, resources, totals }
}

const createRpcRuntimeSession: CreateAgentSessionRuntimeFactory = (options) =>
  createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir }).then((services) =>
    createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
    }).then((result) => ({ ...result, services, diagnostics: services.diagnostics })),
  )

export const normalizePiMessage = (message: unknown): unknown => {
  if (typeof message !== "object" || message === null) return message
  const value = message as { readonly role?: unknown; readonly content?: unknown }
  if (!Array.isArray(value.content)) return message
  return {
    ...value,
    content: value.content.map((block) => {
      if (typeof block !== "object" || block === null) return block
      const content = block as {
        readonly type?: unknown
        readonly data?: unknown
        readonly mimeType?: unknown
      }
      if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
        return {
          type: "image",
          source: { type: "base64", data: content.data, media_type: content.mimeType },
        }
      }
      if (value.role !== "assistant" || content.type !== "toolCall") return block
      const raw = block as {
        readonly id?: unknown
        readonly name?: unknown
        readonly arguments?: unknown
        readonly toolCallId?: unknown
        readonly toolName?: unknown
        readonly input?: unknown
      }
      return {
        type: "toolCall",
        toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : typeof raw.id === "string" ? raw.id : "",
        toolName: typeof raw.toolName === "string" ? raw.toolName : typeof raw.name === "string" ? raw.name : "",
        input:
          typeof raw.input === "object" && raw.input !== null
            ? raw.input
            : typeof raw.arguments === "object" && raw.arguments !== null
              ? raw.arguments
              : {},
      }
    }),
  }
}

const normalizeEntry = (entry: unknown): unknown => {
  if (typeof entry !== "object" || entry === null) return entry
  const value = entry as { readonly type?: unknown; readonly message?: unknown }
  return value.type === "message" ? { ...value, message: normalizePiMessage(value.message) } : value
}

export const normalizePiTree = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null) return node
  const value = node as {
    readonly entry?: unknown
    readonly children?: unknown
    readonly label?: unknown
    readonly compressedEntryIds?: unknown
  }
  return {
    entry: normalizeEntry(value.entry),
    children: Array.isArray(value.children) ? value.children.map(normalizePiTree) : [],
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(Array.isArray(value.compressedEntryIds) &&
    value.compressedEntryIds.every((entryId) => typeof entryId === "string")
      ? { compressedEntryIds: value.compressedEntryIds }
      : {}),
  }
}

const patchExportHtml = (source: string): Effect.Effect<string, PiAdapterError> =>
  Effect.gen(function* () {
    const normalize = (value: string) => value.replace(/\r\n/g, "\n")
    let html = normalize(source)
    const replaceRequired = (name: string, search: string, replacement: string) => {
      const expected = normalize(search)
      const matches = html.split(expected).length - 1
      if (matches !== 1) {
        return Effect.fail(
          new PiAdapterError({
            operation: "session.export.patch",
            message: `${name} expected one match, found ${matches}`,
          }),
        )
      }
      html = html.replace(expected, normalize(replacement))
      return Effect.void
    }

    yield* replaceRequired(
      "sortChildren",
      `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
      `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
          }
        }`,
    )
    yield* replaceRequired(
      "mapNodes",
      `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
      `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
          }`,
    )
    yield* replaceRequired(
      "markActive",
      `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
      `        function markActive(root) {
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) stack1.push(child);
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) if (containsActive.get(child)) has = true;
            containsActive.set(node, has);
          }
        }`,
    )
    return html
  })

const readSession = (filePath: string) =>
  Effect.gen(function* () {
    const manager = yield* Effect.try({
      try: () => SessionManager.open(filePath),
      catch: adapterError("session.open"),
    })
    const entries = yield* decode(
      Schema.Array(SessionEntry),
      "session.entries",
      manager.getEntries().map(normalizeEntry),
    )
    const tree = yield* decode(Schema.Array(SessionTreeNode), "session.tree", manager.getTree().map(normalizePiTree))
    const header = manager.getHeader()
    const leafId = manager.getLeafId() ?? null
    const piContext = piBuildSessionContext(manager.getEntries() as Parameters<typeof piBuildSessionContext>[0], leafId)
    return {
      filePath,
      id: manager.getSessionId(),
      cwd: manager.getCwd(),
      name: manager.getSessionName() || undefined,
      created: header?.timestamp ?? "",
      parentSessionPath: header?.parentSession,
      leafId,
      entries,
      tree,
      thinkingLevel: piContext.thinkingLevel,
      model: piContext.model ?? null,
    } satisfies PiSessionDocument
  })

const withExtensionTools = (session: AgentSessionLike, toolNames: ReadonlyArray<string>): ReadonlyArray<string> => {
  const active = new Set(session.getActiveToolNames())
  const tools = session.getAllTools().map((tool) => ({ ...tool, active: active.has(tool.name) }))
  return mergeBuiltinSelectionWithActiveExtensions(tools, [...toolNames])
}

export const matchExtensionInteractionResponse = (
  interaction: ExtensionInteractionValue,
  response: ExtensionInteractionAnswerValue,
):
  | {
      readonly _tag: "Accepted"
      readonly value: { readonly value?: string; readonly confirmed?: boolean; readonly cancelled?: true }
    }
  | { readonly _tag: "Rejected" } => {
  if (response._tag === "Cancelled") return { _tag: "Accepted", value: { cancelled: true } }
  if (interaction.method === "confirm") {
    return response._tag === "Confirmation"
      ? { _tag: "Accepted", value: { confirmed: response.confirmed } }
      : { _tag: "Rejected" }
  }
  return response._tag === "Value" ? { _tag: "Accepted", value: { value: response.value } } : { _tag: "Rejected" }
}

const makeRuntime = (
  runtime: AgentSessionRuntime,
  crypto: Crypto.Crypto,
  created: string,
  identity: typeof RuntimeIdentity.Type,
  toolNames?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const inner = runtime.session as unknown as AgentSessionLike
    // Prompt returns before the browser can open SSE, so late subscribers need a
    // bounded replay window. Sliding capacity prevents a stalled tab from
    // retaining an unbounded stream of token updates.
    const events = yield* PubSub.sliding<RuntimeEnvelopeValue>({ capacity: 256, replay: 64 })
    const runIdRef = yield* Ref.make<RunId | null>(null)
    const firstMessageRef = yield* Ref.make<string | null>(null)
    const promptRunning = yield* Ref.make(false)
    const activeBash = yield* Ref.make<typeof ActiveBashExecution.Type | null>(null)
    const completedBash = yield* Ref.make<typeof CompletedBashExecution.Type | null>(null)
    let extensionUi = ExtensionUiProjection.make({
      revision: 0,
      pendingInteraction: null,
      statuses: [],
      widgets: [],
    })
    let pendingUi: {
      readonly interaction: ExtensionInteractionValue
      readonly deferred: Deferred.Deferred<{
        readonly value?: string
        readonly confirmed?: boolean
        readonly cancelled?: true
      }>
    } | null = null
    const interactionLock = yield* Semaphore.make(1)
    const promptRequestLock = yield* Semaphore.make(1)
    const promptRequests = new Map<
      string,
      {
        readonly inputDigest: string
        readonly runId: RunId
        readonly deferred: Deferred.Deferred<PromptAndWaitResult, PiAdapterError | PiPromptIdempotencyError>
      }
    >()
    const runFork = yield* FiberSet.makeRuntime()
    const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
      new Promise((resolve, reject) => {
        runFork(effect).addObserver(
          Exit.match({
            onFailure: (cause) => reject(Cause.squash(cause)),
            onSuccess: resolve,
          }),
        )
      })
    const runCallback = (effect: Effect.Effect<unknown, unknown>) => {
      runFork(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Extension UI callback failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      )
    }

    const publish = (event: typeof RunScopedEvent.Type | typeof SessionScopedEvent.Type) => {
      PubSub.publishUnsafe(events, RuntimeEnvelope.make({ identity, event }))
    }
    const currentRunId = () => Ref.getUnsafe(runIdRef)
    const publishForRun = (make: (runId: RunId) => typeof RunScopedEvent.Type | null) => {
      const runId = currentRunId()
      if (runId === null) return
      const event = make(runId)
      if (event !== null) publish(event)
    }

    const commitExtensionUi = (
      update: (current: typeof ExtensionUiProjection.Type) => Omit<typeof ExtensionUiProjection.Type, "revision">,
    ) => {
      extensionUi = ExtensionUiProjection.make({ ...update(extensionUi), revision: extensionUi.revision + 1 })
      publish(SessionScopedEvent.make({ _tag: "ExtensionUiChanged", projection: extensionUi }))
    }

    const emitNotice = (message: string, notifyType: "info" | "warning" | "error" = "info") =>
      runCallback(
        crypto.randomUUIDv4.pipe(
          Effect.tap((noticeId) =>
            Effect.sync(() =>
              publish(SessionScopedEvent.make({ _tag: "ExtensionNotice", noticeId, message, notifyType })),
            ),
          ),
        ),
      )

    type InteractionInput = ExtensionInteractionValue extends infer Interaction
      ? Interaction extends { readonly interactionId: string }
        ? Omit<Interaction, "interactionId">
        : never
      : never

    const requestUi = <A>(
      request: InteractionInput,
      select: (response: { readonly value?: string; readonly confirmed?: boolean; readonly cancelled?: true }) => A,
    ): Promise<A> =>
      runPromise(
        interactionLock.withPermits(1)(
          Effect.gen(function* () {
            const interactionId = yield* crypto.randomUUIDv4
            const interaction = { interactionId, ...request } as ExtensionInteractionValue
            const deferred = yield* Deferred.make<{
              readonly value?: string
              readonly confirmed?: boolean
              readonly cancelled?: true
            }>()
            yield* Effect.sync(() => {
              pendingUi = { interaction, deferred }
              commitExtensionUi((current) => ({ ...current, pendingInteraction: interaction }))
            })
            const response = yield* Deferred.await(deferred).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (pendingUi?.interaction.interactionId !== interactionId) return
                  pendingUi = null
                  commitExtensionUi((current) => ({ ...current, pendingInteraction: null }))
                }),
              ),
            )
            return select(response)
          }),
        ),
      )

    const uiContext = {
      select: (title: string, options: ReadonlyArray<string>) =>
        requestUi({ method: "select", title, options: [...options] }, (response) => response.value),
      confirm: (title: string, message: string) =>
        requestUi({ method: "confirm", title, message }, (response) => response.confirmed === true),
      input: (title: string, placeholder?: string) =>
        requestUi(
          { method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
          (response) => response.value,
        ),
      editor: (title: string, prefill?: string) =>
        requestUi(
          { method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
          (response) => response.value,
        ),
      notify: (message: string, notifyType?: "info" | "warning" | "error") => {
        emitNotice(message, notifyType)
      },
      onTerminalInput: () => () => undefined,
      setStatus: (key: string, text?: string) => {
        commitExtensionUi((current) => ({
          ...current,
          statuses: [
            ...current.statuses.filter((item) => item.key !== key),
            ...(text === undefined ? [] : [ExtensionStatusContribution.make({ _tag: "Text", key, text })]),
          ],
        }))
      },
      setStructuredStatus: (key: string, value?: unknown) => {
        const status = value === undefined ? undefined : extensionStructuredStatusOrUndefined(value)
        if (value !== undefined && status === undefined) {
          runCallback(Effect.logWarning("Ignored non-JSON extension status projection", { key }))
          return
        }
        commitExtensionUi((current) => ({
          ...current,
          statuses: [
            ...current.statuses.filter((item) => item.key !== key),
            ...(status === undefined ? [] : [ExtensionStatusContribution.make({ _tag: "Structured", key, ...status })]),
          ],
        }))
      },
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (
        key: string,
        content?: ReadonlyArray<string>,
        options?: { readonly placement?: "aboveEditor" | "belowEditor" },
      ) => {
        commitExtensionUi((current) => ({
          ...current,
          widgets: [
            ...current.widgets.filter((item) => item.key !== key),
            ...(content === undefined
              ? []
              : [
                  ExtensionWidgetItem.make({
                    key,
                    content: { kind: "text", lines: [...content] },
                    placement: options?.placement ?? "aboveEditor",
                  }),
                ]),
          ],
        }))
      },
      setImageWidget: (
        key: string,
        image?: unknown,
        options?: { readonly placement?: "aboveEditor" | "belowEditor" },
      ) => {
        const content = image === undefined ? undefined : Option.getOrUndefined(decodeExtensionImageWidget(image))
        if (image !== undefined && content === undefined) {
          runCallback(Effect.logWarning("Ignored invalid extension image widget", { key }))
          return
        }
        commitExtensionUi((current) => ({
          ...current,
          widgets: [
            ...current.widgets.filter((item) => item.key !== key),
            ...(content === undefined
              ? []
              : [
                  ExtensionWidgetItem.make({
                    key,
                    content,
                    placement: options?.placement ?? "aboveEditor",
                  }),
                ]),
          ],
        }))
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: () =>
        Promise.reject(
          new PiAdapterError({
            operation: "runtime.customUi",
            message: "Custom terminal UI is unavailable in pi-web",
          }),
        ),
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme: PLAIN_TEXT_THEME,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-web" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    }

    let messageEventSequence = 0
    const unsubscribe = inner.subscribe((raw) => {
      if (typeof raw !== "object" || raw === null) return
      const event = raw as Record<string, unknown>
      const type = event.type
      if (typeof type !== "string") return
      publishForRun((runId) => {
        switch (type) {
          case "agent_start":
            return RunScopedEvent.make({ _tag: "RunStarted", runId })
          case "agent_end":
            return RunScopedEvent.make({ _tag: "RunFinished", runId })
          case "message_start": {
            const message = Schema.decodeUnknownOption(AgentMessage)(normalizePiMessage(event.message))
            return Option.isSome(message)
              ? RunScopedEvent.make({ _tag: "MessageStarted", runId, message: message.value })
              : null
          }
          case "message_update": {
            const message = Schema.decodeUnknownOption(AgentMessage)(normalizePiMessage(event.message))
            return Option.isSome(message)
              ? RunScopedEvent.make({ _tag: "MessageUpdated", runId, message: message.value })
              : null
          }
          case "message_end": {
            const message = Schema.decodeUnknownOption(AgentMessage)(normalizePiMessage(event.message))
            return Option.isSome(message)
              ? RunScopedEvent.make({
                  _tag: "MessageFinished",
                  eventId: `${runId}:message:${messageEventSequence++}`,
                  runId,
                  message: message.value,
                })
              : null
          }
          case "tool_execution_start":
            return RunScopedEvent.make({
              _tag: "ToolStarted",
              runId,
              toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
              toolName: typeof event.toolName === "string" ? event.toolName : "",
            })
          case "tool_execution_end":
            return RunScopedEvent.make({
              _tag: "ToolFinished",
              runId,
              toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
            })
          case "queue_update":
            return RunScopedEvent.make({
              _tag: "QueueChanged",
              runId,
              queued: {
                steering: Array.isArray(event.steering) ? event.steering.map(String) : [],
                followUp: Array.isArray(event.followUp) ? event.followUp.map(String) : [],
              },
            })
          case "auto_retry_start":
            return RunScopedEvent.make({
              _tag: "RetryStarted",
              runId,
              attempt: Number(event.attempt ?? 0),
              maxAttempts: Number(event.maxAttempts ?? 0),
              ...(typeof event.errorMessage === "string" ? { errorMessage: "Provider request failed; retrying" } : {}),
            })
          case "auto_retry_end":
            return RunScopedEvent.make({ _tag: "RetryFinished", runId })
          case "auto_compaction_start":
          case "compaction_start":
            return RunScopedEvent.make({ _tag: "CompactionStarted", runId })
          case "auto_compaction_end":
          case "compaction_end": {
            const result =
              typeof event.result === "object" && event.result !== null ? (event.result as Record<string, unknown>) : {}
            return RunScopedEvent.make({
              _tag: "CompactionFinished",
              runId,
              aborted: event.aborted === true,
              ...(typeof event.errorMessage === "string" ? { errorMessage: "Compaction failed" } : {}),
              ...(typeof result.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
              ...(typeof result.estimatedTokensAfter === "number"
                ? { estimatedTokensAfter: result.estimatedTokensAfter }
                : {}),
              ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
            })
          }
          default:
            return null
        }
      })
    })

    if (typeof inner.bindExtensions === "function") {
      yield* Effect.tryPromise({
        try: () =>
          inner.bindExtensions!({
            uiContext,
            mode: "rpc",
            commandContextActions: {
              waitForIdle: () => inner.waitForIdle(),
              newSession: () => Promise.resolve({ cancelled: true }),
              fork: () => Promise.resolve({ cancelled: true }),
              navigateTree: (targetId: string, options?: { readonly summarize?: boolean }) =>
                inner.navigateTree(targetId, { summarize: options?.summarize }),
              switchSession: () => Promise.resolve({ cancelled: true }),
              reload: () =>
                inner.reload({ beforeSessionStart: () => inner.extensionRunner.setUIContext?.(uiContext, "rpc") }),
            },
            shutdownHandler: () =>
              uiContext.notify("Extension requested shutdown, which is not available in pi-web.", "warning"),
            onError: () =>
              publish(
                SessionScopedEvent.make({
                  _tag: "ExtensionFailed",
                  message: "Extension operation failed",
                }),
              ),
          }),
        catch: adapterError("runtime.bindExtensions"),
      })
    } else {
      inner.extensionRunner.setUIContext?.(uiContext, "rpc")
    }

    const selectedTools = withExtensionTools(inner, toolNames ?? getToolNamesForPreset(DEFAULT_TOOL_PRESET))
    inner.setActiveToolsByName(selectedTools)
    if (selectedTools.length === 0 && inner.agent.state) inner.agent.state.systemPrompt = ""

    const snapshot = Effect.gen(function* () {
      const runId = yield* Ref.get(runIdRef)
      const isPromptRunning = yield* Ref.get(promptRunning)
      const activeBashExecution = yield* Ref.get(activeBash)
      const completedBashExecution = yield* Ref.get(completedBash)
      const usage = inner.getContextUsage()
      return yield* decode(RuntimeSnapshot, "runtime.snapshot", {
        identity,
        runId,
        sessionId: inner.sessionId,
        sessionFile: inner.sessionFile ?? "",
        isStreaming: inner.isStreaming,
        isPromptRunning,
        isCompacting: inner.isCompacting,
        isBashRunning: activeBashExecution !== null,
        activeBashExecution,
        completedBashExecution,
        autoCompactionEnabled: inner.autoCompactionEnabled,
        autoRetryEnabled: inner.autoRetryEnabled,
        ...(inner.model === undefined ? {} : { model: { id: inner.model.id, provider: inner.model.provider } }),
        pendingMessageCount: inner.pendingMessageCount,
        queuedMessages: { steering: [...inner.getSteeringMessages()], followUp: [...inner.getFollowUpMessages()] },
        contextUsage: usage === undefined ? null : usage,
        systemPrompt: inner.agent.state?.systemPrompt ?? "",
        thinkingLevel: inner.agent.state?.thinkingLevel ?? "off",
        extensionUi,
      })
    })

    const invokeCompanionCommand = (name: string, args: string) =>
      Effect.gen(function* () {
        const command = inner.extensionRunner.getCommand(name)
        if (command === undefined)
          return yield* new PiAdapterError({
            operation: `runtime.companion.${name}`,
            message: `Companion command is unavailable: /${name}`,
          })
        yield* Effect.tryPromise({
          try: () => command.handler(args, inner.extensionRunner.createCommandContext()),
          catch: adapterError(`runtime.companion.${name}`),
        })
        return undefined
      })

    const chromeControlArgument = (request: ChromeControlRequestType): string => {
      switch (request.action._tag) {
        case "Authorize":
          return "authorize"
        case "Revoke":
          return "revoke"
        case "WebAttach":
          return `web-attach ${request.action.offer}`
        case "WebAssert":
          return `web-assert ${request.action.pairingId}`
        case "WebDetach":
          return `web-detach ${request.action.pairingId}`
      }
    }

    const weixinControlArgument = (request: WeixinControlRequestType): string => request.action._tag.toLowerCase()

    const piRuntime: PiRuntime = {
      sessionId: inner.sessionId,
      sessionFile: inner.sessionFile ?? "",
      cwd: inner.sessionManager.getCwd(),
      created,
      firstMessage: Ref.get(firstMessageRef),
      isConversationEmpty: Effect.sync(
        () => !inner.sessionManager.getEntries().some((entry) => entry.type === "message"),
      ),
      events,
      publishRunEvent: publish,
      snapshot,
      promptRequest: (proposedRunId, requestId, input) =>
        Effect.gen(function* () {
          const digest = yield* crypto
            .digest("SHA-256", new TextEncoder().encode(canonicalPromptInput(input)))
            .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(adapterError("runtime.promptRequest.digest")))

          type Decision =
            | { readonly _tag: "Completed"; readonly result: PromptAndWaitResult }
            | {
                readonly _tag: "Wait"
                readonly runId: RunId
                readonly deferred: Deferred.Deferred<PromptAndWaitResult, PiAdapterError | PiPromptIdempotencyError>
              }
            | {
                readonly _tag: "Execute"
                readonly startedEntryId: string
                readonly runId: RunId
                readonly deferred: Deferred.Deferred<PromptAndWaitResult, PiAdapterError | PiPromptIdempotencyError>
              }

          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const decision = yield* promptRequestLock.withPermits(1)(
                Effect.gen(function* () {
                  const active = promptRequests.get(requestId)
                  if (active !== undefined) {
                    if (active.inputDigest !== digest) {
                      return yield* new PiPromptIdempotencyError({
                        requestId,
                        reason: "PayloadMismatch",
                        message: "Request id is already active with a different payload",
                      })
                    }
                    return {
                      _tag: "Wait",
                      runId: active.runId,
                      deferred: active.deferred,
                    } satisfies Decision
                  }

                  const persisted = decidePromptRequest(inner.sessionManager.getEntries(), requestId, digest)
                  if (persisted._tag === "Completed") {
                    return {
                      _tag: "Completed",
                      result: { runId: persisted.runId, text: persisted.text },
                    } satisfies Decision
                  }
                  if (persisted._tag === "PayloadMismatch" || persisted._tag === "InDoubt") {
                    return yield* new PiPromptIdempotencyError({
                      requestId,
                      reason: persisted._tag,
                      message:
                        persisted._tag === "PayloadMismatch"
                          ? "Request id was already used with a different payload"
                          : "Request may have executed before completion was recorded",
                    })
                  }
                  if (
                    promptRequests.size > 0 ||
                    inner.isStreaming ||
                    inner.isCompacting ||
                    inner.isBashRunning ||
                    Ref.getUnsafe(promptRunning)
                  ) {
                    return yield* new PiPromptBusyError({ message: "Session already has an active operation" })
                  }

                  const runId = proposedRunId
                  const startedEntryId = yield* Effect.try({
                    try: () =>
                      inner.sessionManager.appendCustomEntry(PROMPT_REQUEST_ENTRY_TYPE, {
                        version: 1,
                        state: "Started",
                        requestId,
                        inputDigest: digest,
                        runId,
                      }),
                    catch: adapterError("runtime.promptRequest.start"),
                  })
                  const deferred = yield* Deferred.make<
                    PromptAndWaitResult,
                    PiAdapterError | PiPromptIdempotencyError
                  >()
                  promptRequests.set(requestId, { inputDigest: digest, runId, deferred })
                  return { _tag: "Execute", startedEntryId, runId, deferred } satisfies Decision
                }),
              )

              if (decision._tag === "Completed") {
                return {
                  runId: decision.result.runId,
                  completion: Effect.succeed(decision.result),
                }
              }
              if (decision._tag === "Wait") {
                return {
                  runId: decision.runId,
                  completion: Deferred.await(decision.deferred),
                }
              }

              const accepted = yield* Deferred.make<void, PiAdapterError>()
              const rejected = new PiAdapterError({
                operation: "runtime.promptRequest.preflight",
                message: "Prompt was rejected before execution",
              })
              const execution = Effect.gen(function* () {
                yield* Ref.set(runIdRef, decision.runId)
                yield* Ref.set(promptRunning, true)
                yield* Effect.tryPromise({
                  try: () =>
                    inner.prompt(input.message, {
                      ...(input.images?.length ? { images: input.images } : {}),
                      source: "rpc",
                      preflightResult: (isAccepted) => {
                        Deferred.doneUnsafe(accepted, isAccepted ? Effect.void : Effect.fail(rejected))
                        if (isAccepted && Ref.getUnsafe(firstMessageRef) === null && input.message.trim()) {
                          firstMessageRef.ref.current = input.message
                        }
                      },
                    }),
                  catch: adapterError("runtime.promptRequest"),
                })
                yield* Deferred.await(accepted)
                yield* Effect.tryPromise({ try: () => inner.waitForIdle(), catch: adapterError("runtime.waitForIdle") })
                const result = { runId: decision.runId, text: inner.getLastAssistantText() ?? "" }
                yield* Effect.try({
                  try: () =>
                    inner.sessionManager.appendCustomEntry(PROMPT_REQUEST_ENTRY_TYPE, {
                      version: 1,
                      state: "Completed",
                      startedEntryId: decision.startedEntryId,
                      text: result.text,
                    }),
                  catch: adapterError("runtime.promptRequest.complete"),
                })
                return result
              }).pipe(
                Effect.ensuring(
                  Ref.set(promptRunning, false).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        Deferred.doneUnsafe(accepted, Effect.fail(rejected))
                      }),
                    ),
                  ),
                ),
              )

              yield* Effect.sync(() => {
                runFork(execution).addObserver((exit) => {
                  const active = promptRequests.get(requestId)
                  if (active?.deferred === decision.deferred) promptRequests.delete(requestId)
                  Deferred.doneUnsafe(
                    decision.deferred,
                    Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
                  )
                })
              })
              yield* Deferred.await(accepted)
              return {
                runId: decision.runId,
                completion: Deferred.await(decision.deferred),
              }
            }),
          )
        }),
      steer: (message, images) =>
        Effect.tryPromise({
          try: () => inner.steer(message, images?.length ? images : undefined),
          catch: adapterError("runtime.steer"),
        }),
      followUp: (message, images) =>
        Effect.tryPromise({
          try: () => inner.followUp(message, images?.length ? images : undefined),
          catch: adapterError("runtime.followUp"),
        }),
      abort: Effect.tryPromise({ try: () => inner.abort(), catch: adapterError("runtime.abort") }),
      executeBash: (runId, id, command, excludeFromContext) =>
        Effect.gen(function* () {
          yield* Ref.set(runIdRef, runId)
          const startedAt = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
          const active = ActiveBashExecution.make({ id, command, output: "", excludeFromContext, startedAt })
          yield* Ref.set(activeBash, active)
          publish(RunScopedEvent.make({ _tag: "BashStarted", runId, execution: active }))
          const extensionResult = yield* Effect.tryPromise({
            try: () =>
              inner.extensionRunner.emitUserBash({
                type: "user_bash",
                command,
                excludeFromContext,
                cwd: inner.sessionManager.getCwd(),
              }),
            catch: adapterError("runtime.userBash"),
          })
          const result =
            extensionResult?.result === undefined
              ? yield* Effect.tryPromise({
                  try: () =>
                    inner.executeBash(
                      command,
                      (chunk) => {
                        const current = Ref.getUnsafe(activeBash)
                        if (current?.id === id) {
                          activeBash.ref.current = {
                            ...current,
                            output: appendLiveBashOutput(current.output, chunk),
                          }
                        }
                        publish(RunScopedEvent.make({ _tag: "BashOutput", runId, id, chunk }))
                      },
                      { excludeFromContext, operations: extensionResult?.operations },
                    ),
                  catch: adapterError("runtime.bash"),
                })
              : extensionResult.result
          if (extensionResult?.result !== undefined) inner.recordBashResult(command, result, { excludeFromContext })
          const timestamp = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
          const completed = yield* decode(CompletedBashExecution, "runtime.bashResult", {
            id,
            message: {
              role: "bashExecution",
              command,
              output: result.output,
              exitCode: result.exitCode,
              cancelled: result.cancelled,
              truncated: result.truncated,
              ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
              timestamp,
              excludeFromContext,
            },
          })
          yield* Ref.set(completedBash, completed)
          yield* Ref.set(activeBash, null)
          publish(RunScopedEvent.make({ _tag: "BashFinished", runId, execution: completed }))
          return completed
        }).pipe(Effect.ensuring(Ref.set(activeBash, null))),
      abortBash: Effect.sync(() => inner.abortBash()),
      setModel: (provider, modelId) =>
        Effect.gen(function* () {
          const model = inner.modelRegistry.find(provider, modelId)
          if (model === undefined)
            return yield* new PiAdapterError({
              operation: "runtime.setModel",
              message: `Model not found: ${provider}/${modelId}`,
            })
          yield* Effect.tryPromise({ try: () => inner.setModel(model), catch: adapterError("runtime.setModel") })
          return { id: model.id, provider: model.provider }
        }),
      navigate: (targetId) =>
        Effect.tryPromise({
          try: () => inner.navigateTree(targetId, {}),
          catch: adapterError("runtime.navigate"),
        }),
      setThinkingLevel: (level) =>
        Effect.sync(() => {
          inner.setThinkingLevel(level)
          if (level === "xhigh" && inner.model?.compat?.thinkingFormat === "deepseek" && inner.agent.state) {
            inner.agent.state.thinkingLevel = "xhigh"
          }
        }),
      compact: (runId, instructions) =>
        Effect.gen(function* () {
          yield* Ref.set(runIdRef, runId)
          const value = yield* Effect.tryPromise({
            try: () => inner.compact(instructions),
            catch: adapterError("runtime.compact"),
          })
          if (typeof value !== "object" || value === null) return {}
          const result = value as Record<string, unknown>
          return {
            ...(typeof result.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
            ...(typeof result.estimatedTokensAfter === "number"
              ? { estimatedTokensAfter: result.estimatedTokensAfter }
              : {}),
          }
        }),
      abortCompaction: Effect.sync(() => inner.abortCompaction()),
      setSessionName: (name) => Effect.sync(() => inner.setSessionName(name)),
      stats: decode(SessionStats, "runtime.stats", {
        ...(inner.getSessionStats() as Record<string, unknown>),
        sessionName: inner.sessionManager.getSessionName() || undefined,
      }),
      lastAssistantText: Effect.sync(() => inner.getLastAssistantText() ?? ""),
      setAutoCompaction: (enabled) => Effect.sync(() => inner.setAutoCompactionEnabled(enabled)),
      setAutoRetry: (enabled) => Effect.sync(() => inner.setAutoRetryEnabled(enabled)),
      clearQueue: decode(QueuedMessages, "runtime.clearQueue", inner.clearQueue()),
      tools: Effect.sync(() => {
        const active = new Set(inner.getActiveToolNames())
        return inner.getAllTools().map((tool) => ToolEntry.make({ ...tool, active: active.has(tool.name) }))
      }),
      commands: Effect.gen(function* () {
        const values = [
          ...inner.extensionRunner.getRegisteredCommands().map((command) => ({
            name: command.invocationName,
            description: command.description,
            source: "extension" as const,
            sourceInfo: command.sourceInfo,
          })),
          ...inner.promptTemplates.map((template) => ({
            name: template.name,
            description: template.description,
            source: "prompt" as const,
            sourceInfo: template.sourceInfo,
          })),
          ...inner.resourceLoader.getSkills().skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill" as const,
            sourceInfo: skill.sourceInfo,
          })),
        ]
        return yield* decode(Schema.Array(SlashCommand), "runtime.commands", values)
      }),
      setTools: (names) =>
        Effect.sync(() => {
          const active = withExtensionTools(inner, names)
          inner.setActiveToolsByName(active)
          if (active.length === 0 && inner.agent.state) inner.agent.state.systemPrompt = ""
        }),
      invokeSlashCommand: invokeCompanionCommand,
      controlLoop: (request) => invokeCompanionCommand("loop-control", JSON.stringify(request)),
      controlWeixin: (request) => invokeCompanionCommand("weixin", weixinControlArgument(request)),
      controlChrome: (request) => invokeCompanionCommand("chrome", chromeControlArgument(request)),
      resolveInteraction: (interactionId, response) =>
        Effect.gen(function* () {
          const current = pendingUi
          if (current === null || current.interaction.interactionId !== interactionId) {
            return yield* new PiInteractionConflictError({ interactionId })
          }
          const matched = matchExtensionInteractionResponse(current.interaction, response.answer)
          if (matched._tag === "Rejected") {
            return yield* new PiInteractionResponseError({
              interactionId,
              method: current.interaction.method,
              responseTag: response.answer._tag,
            })
          }
          pendingUi = null
          commitExtensionUi((projection) => ({ ...projection, pendingInteraction: null }))
          yield* Deferred.succeed(current.deferred, matched.value)
        }),
      reload: Effect.tryPromise({
        try: () => inner.reload({ beforeSessionStart: () => inner.extensionRunner.setUIContext?.(uiContext, "rpc") }),
        catch: adapterError("runtime.reload"),
      }),
      dispose: Effect.gen(function* () {
        unsubscribe()
        const current = pendingUi
        if (current !== null) {
          pendingUi = null
          commitExtensionUi((projection) => ({ ...projection, pendingInteraction: null }))
          yield* Deferred.succeed(current.deferred, { cancelled: true })
        }
        yield* PubSub.shutdown(events)
        yield* Effect.tryPromise({ try: () => runtime.dispose(), catch: () => undefined }).pipe(Effect.ignore)
      }),
    }
    return piRuntime
  })

const adapterLive = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const loginCallbacks = new Map<
    string,
    {
      readonly provider: string
      readonly resolve: (value: string) => void
      readonly reject: (error: Error) => void
    }
  >()

  const modelsPath = path.join(getAgentDir(), "models.json")
  const defaultModelsConfig = ModelsConfig.make({ providers: {} })

  const encodeModelsConfig = (value: typeof ModelsConfig.Type) =>
    Schema.encodeUnknownEffect(ModelsConfig)(value).pipe(Effect.mapError(adapterError("models.config.encode")))

  const validateEncodedModelsConfig = (encoded: unknown) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "pi-web-models-validate-" })
          .pipe(Effect.mapError(adapterError("models.config.validate.temp")))
        const filePath = path.join(directory, "models.json")
        yield* fs
          .writeFileString(filePath, JSON.stringify(encoded, null, 2))
          .pipe(Effect.mapError(adapterError("models.config.validate.write")))
        const loadError = ModelRegistry.create(AuthStorage.create(), filePath).getError()
        return loadError === undefined
          ? ModelConfigValidation.make({ valid: true })
          : ModelConfigValidation.make({ valid: false, error: loadError.split("\n\nFile:")[0] ?? loadError })
      }),
    )

  const validateModelsConfig = (value: typeof ModelsConfig.Type) =>
    encodeModelsConfig(value).pipe(Effect.flatMap(validateEncodedModelsConfig))

  const readModelsConfig = Effect.gen(function* () {
    const source = yield* fs.readFileString(modelsPath).pipe(
      Effect.map((value) => value as string | null),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(adapterError("models.config.read")),
    )
    if (source === null) return defaultModelsConfig
    const value = yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: adapterError("models.config.parse"),
    })
    return yield* decode(ModelsConfig, "models.config.decode", value)
  })

  const saveModelsConfig = (value: typeof ModelsConfig.Type) =>
    Effect.gen(function* () {
      const encoded = yield* encodeModelsConfig(value)
      const validation = yield* validateEncodedModelsConfig(encoded)
      if (!validation.valid) {
        return yield* new PiAdapterError({ operation: "models.config.validate", message: validation.error })
      }
      yield* fs
        .makeDirectory(path.dirname(modelsPath), { recursive: true })
        .pipe(Effect.mapError(adapterError("models.config.mkdir")))
      const suffix = yield* crypto.randomUUIDv4.pipe(Effect.mapError(adapterError("models.config.tempName")))
      const temporaryPath = `${modelsPath}.${suffix}.tmp`
      yield* fs
        .writeFileString(temporaryPath, JSON.stringify(encoded, null, 2))
        .pipe(
          Effect.mapError(adapterError("models.config.write")),
          Effect.andThen(
            fs.rename(temporaryPath, modelsPath).pipe(Effect.mapError(adapterError("models.config.rename"))),
          ),
          Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)),
        )
    })

  const modelCatalog = (cwd: string) =>
    Effect.gen(function* () {
      const services = yield* Effect.tryPromise({
        try: () => createAgentSessionServices({ cwd, agentDir: getAgentDir() }),
        catch: adapterError("models.catalog"),
      })
      const settings = services.settingsManager
      const available = services.modelRegistry.getAvailable()
      const visible = visibleModels(available, settings.getEnabledModels())
      const modelList = visible
        .map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
        }))
        .sort(
          (left, right) =>
            modelNameCollator.compare(left.name || left.id, right.name || right.id) ||
            modelNameCollator.compare(left.provider, right.provider) ||
            modelNameCollator.compare(left.id, right.id),
        )
      const models: Record<string, string> = {}
      const thinkingLevels: Record<string, ReadonlyArray<string>> = {}
      const thinkingLevelMaps: Record<string, Readonly<Record<string, string | null>>> = {}
      for (const model of visible) {
        const key = `${model.provider}:${model.id}`
        models[key] = model.name
        thinkingLevels[key] = getSupportedThinkingLevels(model)
        if (model.thinkingLevelMap !== undefined) thinkingLevelMaps[key] = model.thinkingLevelMap
      }
      const provider = settings.getDefaultProvider()
      const modelId = settings.getDefaultModel()
      const defaultModel =
        provider !== undefined &&
        modelId !== undefined &&
        visible.some((model) => model.provider === provider && model.id === modelId)
          ? { provider, modelId }
          : null
      return ModelCatalog.make({ models, modelList, defaultModel, thinkingLevels, thinkingLevelMaps })
    })

  const testModelConfig = (providerName: string, provider: JsonValue, model: JsonValue) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!isJsonRecord(provider)) {
          return ModelTestResult.make({ ok: false, error: "provider must be an object" })
        }
        if (!isJsonRecord(model)) {
          return ModelTestResult.make({ ok: false, error: "model must be an object" })
        }
        const id = typeof model.id === "string" ? model.id.trim() : ""
        if (!providerName.trim() || !id) {
          return ModelTestResult.make({ ok: false, error: "providerName and model.id are required" })
        }
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "pi-web-model-test-" })
          .pipe(Effect.mapError(adapterError("models.test.temp")))
        const filePath = path.join(directory, "models.json")
        yield* fs
          .writeFileString(
            filePath,
            JSON.stringify(
              {
                providers: {
                  [providerName]: { ...provider, models: [{ ...model, id }] },
                },
              },
              null,
              2,
            ),
          )
          .pipe(Effect.mapError(adapterError("models.test.write")))
        const registry = ModelRegistry.create(AuthStorage.create(), filePath)
        const loadError = registry.getError()
        if (loadError !== undefined) return ModelTestResult.make({ ok: false, error: loadError })
        const selected = registry.find(providerName, id)
        if (selected === undefined) {
          return ModelTestResult.make({ ok: false, error: `Model not found: ${providerName}/${id}` })
        }
        const auth = yield* Effect.tryPromise({
          try: () => registry.getApiKeyAndHeaders(selected),
          catch: adapterError("models.test.auth"),
        })
        if (!auth.ok) return ModelTestResult.make({ ok: false, error: auth.error })
        if (!auth.apiKey) return ModelTestResult.make({ ok: false, error: `No API key found for "${providerName}"` })
        let status: number | undefined
        const startedAt = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
        const message = yield* Effect.tryPromise({
          try: () =>
            completeSimple(
              selected,
              {
                messages: [{ role: "user", content: "Reply with OK only.", timestamp: startedAt }],
              },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                maxTokens: 16,
                timeoutMs: 20_000,
                maxRetries: 0,
                cacheRetention: "none",
                onResponse: (response) => {
                  status = response.status
                },
              },
            ),
          catch: adapterError("models.test.complete"),
        }).pipe(
          Effect.timeout("21 seconds"),
          Effect.mapError((cause) =>
            cause instanceof PiAdapterError
              ? cause
              : new PiAdapterError({ operation: "models.test.timeout", message: "Model test timed out" }),
          ),
        )
        const finishedAt = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
        const latencyMs = finishedAt - startedAt
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return ModelTestResult.make({
            ok: false,
            error: message.errorMessage ?? "Model returned an error",
            latencyMs,
            ...(status === undefined ? {} : { status }),
          })
        }
        const responseText = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .slice(0, 300)
        return ModelTestResult.make({
          ok: true,
          latencyMs,
          ...(status === undefined ? {} : { status }),
          responseText,
        })
      }),
    )

  const oauthProviders = Effect.try({
    try: () =>
      AuthStorage.create()
        .getOAuthProviders()
        .filter((provider) => provider.id !== "anthropic")
        .map((provider) =>
          OAuthProvider.make({
            id: provider.id,
            name: oauthDisplayNames[provider.id] ?? provider.name,
            usesCallbackServer: provider.usesCallbackServer ?? false,
            loggedIn: AuthStorage.create().has(provider.id),
          }),
        ),
    catch: adapterError("auth.oauthProviders"),
  })

  const apiKeyProviders = Effect.try({
    try: () => {
      const auth = AuthStorage.create()
      const registry = ModelRegistry.create(auth)
      const all = registry.getAll()
      const seen = new Set<string>()
      return all.flatMap((model) => {
        if (seen.has(model.provider) || oauthProviderIds.has(model.provider)) return []
        seen.add(model.provider)
        const status = registry.getProviderAuthStatus(model.provider)
        if (status.source === "models_json_key") return []
        return [
          ApiKeyProvider.make({
            id: model.provider,
            displayName: registry.getProviderDisplayName(model.provider),
            configured: status.configured,
            ...(status.source === undefined ? {} : { source: status.source }),
            modelCount: all.filter((candidate) => candidate.provider === model.provider).length,
          }),
        ]
      })
    },
    catch: adapterError("auth.apiKeyProviders"),
  })

  const apiKeyStatus = (provider: string) =>
    Effect.try({
      try: () => {
        const registry = ModelRegistry.create(AuthStorage.create())
        const status = registry.getProviderAuthStatus(provider)
        return ApiKeyStatus.make({
          provider,
          displayName: registry.getProviderDisplayName(provider),
          configured: status.configured,
          ...(status.source === undefined ? {} : { source: status.source }),
          models: registry.getAll().filter((model) => model.provider === provider).length,
        })
      },
      catch: adapterError("auth.apiKeyStatus"),
    })

  const setApiKey = (provider: string, apiKey: string) =>
    Effect.try({
      try: () => AuthStorage.create().set(provider, { type: "api_key", key: apiKey.trim() }),
      catch: adapterError("auth.setApiKey"),
    })
  const removeApiKey = (provider: string) =>
    Effect.try({
      try: () => AuthStorage.create().remove(provider),
      catch: adapterError("auth.removeApiKey"),
    })

  const oauthEvents = (provider: string) =>
    Effect.gen(function* () {
      const auth = AuthStorage.create()
      if (!auth.getOAuthProviders().some((candidate) => candidate.id === provider)) {
        return yield* new PiAdapterError({ operation: "auth.oauth", message: `Unknown provider: ${provider}` })
      }
      const flowId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(adapterError("auth.oauth.token")))
      return Stream.callback<typeof OAuthEvent.Type, PiAdapterError>((queue) =>
        Effect.gen(function* () {
          const activeTokens = new Set<string>()
          let sequence = 0
          let pending: { readonly token: string; readonly promise: Promise<string> } | null = null
          const emit = (event: typeof OAuthEvent.Type) => Queue.offerUnsafe(queue, event)
          const createInput = () => {
            const token = `${provider}-${flowId}-${sequence++}`
            activeTokens.add(token)
            const promise = new Promise<string>((resolve, reject) => {
              loginCallbacks.set(token, {
                provider,
                resolve: (value) => {
                  loginCallbacks.delete(token)
                  activeTokens.delete(token)
                  resolve(value)
                },
                reject: (error) => {
                  loginCallbacks.delete(token)
                  activeTokens.delete(token)
                  reject(error)
                },
              })
            })
            return { token, promise }
          }
          const manualInput = () => {
            if (pending === null) {
              const current = createInput()
              pending = {
                token: current.token,
                promise: current.promise.finally(() => {
                  pending = null
                }),
              }
            }
            return pending
          }
          const cleanup = Effect.sync(() => {
            for (const token of activeTokens) {
              loginCallbacks
                .get(token)
                ?.reject(new PiAdapterError({ operation: "auth.oauth.login", message: "Login cancelled" }))
            }
            activeTokens.clear()
          })
          yield* Effect.addFinalizer(() => cleanup)
          yield* Effect.tryPromise({
            try: () =>
              auth.login(provider as Parameters<AuthStorage["login"]>[0], {
                onAuth: (info) => {
                  const input = manualInput()
                  emit(
                    OAuthEvent.make({
                      _tag: "Auth",
                      url: info.url,
                      instructions: info.instructions ?? null,
                      token: input.token,
                    }),
                  )
                },
                onDeviceCode: (info) =>
                  emit(
                    OAuthEvent.make({
                      _tag: "DeviceCode",
                      userCode: info.userCode,
                      verificationUri: info.verificationUri,
                      intervalSeconds: info.intervalSeconds ?? null,
                      expiresInSeconds: info.expiresInSeconds ?? null,
                    }),
                  ),
                onPrompt: (prompt) => {
                  const input = manualInput()
                  emit(
                    OAuthEvent.make({
                      _tag: "Prompt",
                      message: prompt.message,
                      placeholder: prompt.placeholder ?? null,
                      token: input.token,
                    }),
                  )
                  return input.promise
                },
                onProgress: (message) => emit(OAuthEvent.make({ _tag: "Progress", message })),
                onSelect: (prompt) => {
                  const input = createInput()
                  emit(
                    OAuthEvent.make({
                      _tag: "Select",
                      message: prompt.message,
                      options: prompt.options,
                      token: input.token,
                    }),
                  )
                  return input.promise.then((value) => value || undefined)
                },
                onManualCodeInput: () => manualInput().promise,
              }),
            catch: adapterError("auth.oauth.login"),
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.sync(() => {
                  emit(
                    OAuthEvent.make({
                      _tag: error.message === "Login cancelled" ? "Cancelled" : "Failed",
                      ...(error.message === "Login cancelled" ? {} : { message: "OAuth login failed" }),
                    } as typeof OAuthEvent.Type),
                  )
                  Queue.endUnsafe(queue)
                }),
              onSuccess: () =>
                Effect.sync(() => {
                  emit(OAuthEvent.make({ _tag: "Succeeded" }))
                  Queue.endUnsafe(queue)
                }),
            }),
            Effect.ensuring(cleanup),
            Effect.forkScoped,
          )
        }),
      )
    })

  const submitOAuthInput = (provider: string, token: string, code: string) =>
    Effect.gen(function* () {
      const callback = loginCallbacks.get(token)
      if (callback === undefined || callback.provider !== provider || !token.startsWith(`${provider}-`)) {
        return yield* new PiAdapterError({ operation: "auth.oauth.input", message: "No matching pending OAuth input" })
      }
      yield* Effect.sync(() => callback.resolve(code))
    })

  const logout = (provider: string) =>
    Effect.gen(function* () {
      const auth = yield* Effect.try({
        try: () => AuthStorage.create(),
        catch: adapterError("auth.logout"),
      })
      if (!auth.getOAuthProviders().some((candidate) => candidate.id === provider)) {
        return yield* new PiAdapterError({ operation: "auth.logout", message: "Unknown OAuth provider" })
      }
      yield* Effect.try({
        try: () => auth.logout(provider),
        catch: adapterError("auth.logout"),
      })
    })

  const packageMetadata = (installedPath: string | undefined) =>
    Effect.gen(function* () {
      if (installedPath === undefined) return {}
      const info = yield* fs.stat(installedPath).pipe(Effect.option)
      if (Option.isNone(info)) return {}
      const root = info.value.type === "Directory" ? installedPath : path.dirname(installedPath)
      const packageJson = yield* fs.readFileString(path.join(root, "package.json")).pipe(Effect.option)
      if (Option.isNone(packageJson)) return {}
      const parsed = yield* Effect.try({
        try: () => JSON.parse(packageJson.value) as { readonly name?: unknown; readonly version?: unknown },
        catch: () => new PiAdapterError({ operation: "plugins.metadata", message: "Invalid package metadata" }),
      }).pipe(Effect.option)
      if (Option.isNone(parsed)) return {}
      const packageName = typeof parsed.value.name === "string" ? parsed.value.name : undefined
      const version = typeof parsed.value.version === "string" ? parsed.value.version : undefined
      let chromeExtensionId: string | undefined
      let chromeExtensionDirectory: string | undefined
      if (packageName === PI_COMPANION_PACKAGE_NAMES.chrome) {
        chromeExtensionDirectory = path.join(root, "dist", "browser-extension")
        const manifest = yield* fs
          .readFileString(path.join(chromeExtensionDirectory, "manifest.json"))
          .pipe(Effect.option)
        if (Option.isSome(manifest)) {
          const keyOption = yield* Effect.try({
            try: () => (JSON.parse(manifest.value) as { readonly key?: unknown }).key,
            catch: () => undefined,
          }).pipe(Effect.option)
          const key = Option.isSome(keyOption) ? keyOption.value : undefined
          if (typeof key === "string") {
            const decoded = Encoding.decodeBase64(key)
            if (decoded._tag === "Success") {
              const digest = yield* crypto.digest("SHA-256", decoded.success).pipe(Effect.option)
              if (Option.isSome(digest)) {
                const alphabet = "abcdefghijklmnop"
                chromeExtensionId = Array.from(
                  digest.value.slice(0, 16),
                  (byte) => `${alphabet[byte >> 4]}${alphabet[byte & 0x0f]}`,
                ).join("")
              }
            }
          }
        }
      }
      return {
        ...(packageName === undefined ? {} : { packageName }),
        ...(version === undefined ? {} : { version }),
        ...(chromeExtensionId === undefined ? {} : { chromeExtensionId }),
        ...(chromeExtensionDirectory === undefined ? {} : { chromeExtensionDirectory }),
      }
    })

  const readPlugins = (cwd: string) =>
    Effect.gen(function* () {
      const settings = SettingsManager.create(cwd, getAgentDir())
      const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: settings })
      const diagnostics: Array<{ type: "warning" | "error"; message: string; source?: string }> = []
      const disabled = new Map<string, boolean>()
      for (const entry of settings.getGlobalSettings().packages ?? []) {
        disabled.set(pluginKey(getPackageSource(entry), "global"), isDisabledPackage(entry))
      }
      for (const entry of settings.getProjectSettings().packages ?? []) {
        disabled.set(pluginKey(getPackageSource(entry), "project"), isDisabledPackage(entry))
      }
      const resolved = yield* Effect.tryPromise({
        try: () =>
          manager.resolve((source) => {
            diagnostics.push({ type: "warning", source, message: "Package is configured but not installed yet." })
            return new Promise<"skip">((resolve) => resolve("skip"))
          }),
        catch: adapterError("plugins.resolve"),
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            diagnostics.push({ type: "error", message: error.message })
            return null
          },
          onSuccess: (value) => value,
        }),
      )
      const collected =
        resolved === null
          ? {
              counts: new Map<string, MutableResourceCounts>(),
              resources: new Map<string, ReadonlyArray<PluginResourceValue>>(),
              totals: emptyResourceCounts(),
            }
          : collectPluginResources(path, resolved)
      const packages = yield* Effect.forEach(
        manager.listConfiguredPackages(),
        (configured) =>
          Effect.gen(function* () {
            const scope = pluginScope(configured.scope)
            const key = pluginKey(configured.source, scope)
            const counts = collected.counts.get(key) ?? emptyResourceCounts()
            const resources = collected.resources.get(key) ?? []
            const metadata = yield* packageMetadata(configured.installedPath)
            if (configured.installedPath === undefined) {
              diagnostics.push({
                type: "warning",
                source: configured.source,
                message: "Configured package path was not found.",
              })
            }
            const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes
            const isDisabled = disabled.get(key) ?? false
            return {
              source: configured.source,
              scope,
              filtered: configured.filtered,
              disabled: isDisabled,
              ...(configured.installedPath === undefined ? {} : { installedPath: configured.installedPath }),
              ...metadata,
              ...(configuredVersion(configured.source) === undefined
                ? {}
                : { configuredVersion: configuredVersion(configured.source) }),
              counts,
              resources,
              status: isDisabled
                ? ("disabled" as const)
                : resourceCount > 0
                  ? ("loaded" as const)
                  : configured.installedPath
                    ? ("installed" as const)
                    : ("missing" as const),
            }
          }),
        { concurrency: 8 },
      )
      return yield* decode(PluginsResponse, "plugins.response", {
        packages,
        totals: collected.totals,
        diagnostics,
      })
    })

  const setPackageDisabled = (
    settings: SettingsManager,
    source: string,
    scope: PluginScope,
    value: boolean,
  ): boolean => {
    const current =
      scope === "project"
        ? (settings.getProjectSettings().packages ?? [])
        : (settings.getGlobalSettings().packages ?? [])
    const mutation = setConfiguredPackageDisabled(current, source, value)
    if (!mutation.changed) return false
    if (scope === "project") settings.setProjectPackages(mutation.packages)
    else settings.setPackages(mutation.packages)
    return true
  }

  const pluginAction = (
    cwd: string,
    action: PluginAction,
    source: string | undefined,
    rawScope: PluginScope | undefined,
  ) =>
    Effect.gen(function* () {
      const settings = SettingsManager.create(cwd, getAgentDir())
      const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: settings })
      const scope = rawScope ?? "global"
      const normalized = source?.trim()
      if (action !== "update" && !normalized) {
        return yield* new PiAdapterError({ operation: "plugins.action", message: "Package source is required" })
      }
      if (action === "install") {
        yield* Effect.tryPromise({
          try: () => manager.installAndPersist(normalized!, { local: scope === "project" }),
          catch: adapterError("plugins.install"),
        })
        yield* Effect.tryPromise({ try: () => settings.flush(), catch: adapterError("plugins.flush") })
      } else if (action === "remove") {
        const current =
          scope === "project"
            ? (settings.getProjectSettings().packages ?? [])
            : (settings.getGlobalSettings().packages ?? [])
        const mutation = removeConfiguredPackage(current, normalized!)
        if (!mutation.changed)
          return yield* new PiAdapterError({ operation: "plugins.remove", message: "Configured package not found" })
        if (scope === "project") settings.setProjectPackages(mutation.packages)
        else settings.setPackages(mutation.packages)
        yield* Effect.tryPromise({ try: () => settings.flush(), catch: adapterError("plugins.flush") })
      } else if (action === "update") {
        if (normalized !== undefined && !isLocalPackageSource(normalized)) {
          yield* Effect.tryPromise({ try: () => manager.update(normalized), catch: adapterError("plugins.update") })
        }
      } else {
        if (!setPackageDisabled(settings, normalized!, scope, action === "disable")) {
          return yield* new PiAdapterError({ operation: `plugins.${action}`, message: "Configured package not found" })
        }
        yield* Effect.tryPromise({ try: () => settings.flush(), catch: adapterError("plugins.flush") })
      }
      return yield* readPlugins(cwd)
    })

  const skills = (cwd: string) =>
    Effect.gen(function* () {
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() })
      yield* Effect.tryPromise({ try: () => loader.reload(), catch: adapterError("skills.reload") })
      return yield* decode(SkillsResponse, "skills.response", loader.getSkills())
    })

  const toggleSkill = (filePath: string, disabled: boolean) =>
    Effect.gen(function* () {
      const content = yield* fs.readFileString(filePath).pipe(Effect.mapError(adapterError("skills.read")))
      const key = "disable-model-invocation"
      const parsed = yield* Effect.try({
        try: () => parseFrontmatter<Record<string, unknown>>(content),
        catch: adapterError("skills.frontmatter"),
      })
      const alreadyDisabled = Boolean(parsed.frontmatter[key])
      let updated = content
      if (disabled && !alreadyDisabled) {
        updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`)
        if (updated === content) updated = `---\n${key}: true\n---\n${content}`
      } else if (!disabled && alreadyDisabled) {
        updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "")
      }
      if (updated !== content) {
        yield* fs.writeFileString(filePath, updated).pipe(Effect.mapError(adapterError("skills.write")))
      }
    })

  return PiAgentAdapter.of({
    listSessions: Effect.tryPromise({
      try: () =>
        SessionManager.listAll().then((sessions) =>
          sessions.map((session) => ({
            path: session.path,
            id: session.id,
            cwd: session.cwd,
            name: session.name || undefined,
            created:
              session.created instanceof globalThis.Date ? session.created.toISOString() : String(session.created),
            modified:
              session.modified instanceof globalThis.Date ? session.modified.toISOString() : String(session.modified),
            messageCount: session.messageCount,
            firstMessage: session.firstMessage || "(no messages)",
            parentSessionPath: session.parentSessionPath || undefined,
          })),
        ),
      catch: adapterError("sessions.list"),
    }),
    readSession,
    appendSessionName: (filePath, name) =>
      Effect.try({
        try: () => SessionManager.open(filePath).appendSessionInfo(name),
        catch: adapterError("session.rename"),
      }),
    createFork: (filePath, entryId) =>
      Effect.gen(function* () {
        const manager = SessionManager.open(filePath)
        if (!manager.isPersisted()) return { cancelled: true }
        const currentFile = manager.getSessionFile()
        if (!currentFile)
          return yield* new PiAdapterError({ operation: "session.fork", message: "Persisted session has no file" })
        const entry = manager.getEntry(entryId)
        if (!entry) return yield* new PiAdapterError({ operation: "session.fork", message: "Invalid fork entry" })
        const sessionDir = manager.getSessionDir()
        if (entry.parentId === null) {
          const next = SessionManager.create(manager.getCwd(), sessionDir, { parentSession: currentFile })
          const newSessionFile = next.getSessionFile()
          const header = next.getHeader()
          if (!newSessionFile || header === null) {
            return yield* new PiAdapterError({ operation: "session.fork", message: "Failed to create root fork" })
          }
          yield* fs
            .writeFileString(newSessionFile, `${JSON.stringify(header)}\n`)
            .pipe(Effect.mapError(adapterError("session.fork.write")))
          return { cancelled: false, newSessionId: next.getSessionId(), newSessionFile }
        }
        const newSessionFile = SessionManager.open(currentFile, sessionDir).createBranchedSession(entry.parentId)
        if (!newSessionFile)
          return yield* new PiAdapterError({ operation: "session.fork", message: "Failed to create fork" })
        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId()
        return { cancelled: false, newSessionId, newSessionFile }
      }),
    createRuntime: (options, identity) =>
      Effect.gen(function* () {
        const manager =
          options.sessionFile === null ? SessionManager.create(options.cwd) : SessionManager.open(options.sessionFile)
        const created = manager.getHeader()?.timestamp ?? ""
        const runtime = yield* Effect.tryPromise({
          try: () =>
            createAgentSessionRuntime(createRpcRuntimeSession, {
              cwd: options.cwd,
              agentDir: getAgentDir(),
              sessionManager: manager,
            }),
          catch: adapterError("runtime.create"),
        })
        return yield* makeRuntime(runtime, crypto, created, identity, options.toolNames).pipe(
          Effect.tapError(() =>
            Effect.tryPromise({ try: () => runtime.dispose(), catch: () => undefined }).pipe(Effect.ignore),
          ),
        )
      }),
    exportHtml: (filePath) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs
            .makeTempDirectoryScoped({ prefix: "pi-web-export-" })
            .pipe(Effect.mapError(adapterError("session.export.temp")))
          const outputPath = path.join(directory, "session.html")
          const exporterUrl = yield* path
            .toFileUrl(path.join(getPackageDir(), "dist", "core", "export-html", "index.js"))
            .pipe(Effect.mapError(adapterError("session.export.url")))
          const exporter = yield* Effect.tryPromise({
            try: () =>
              import(/* @vite-ignore */ exporterUrl.href) as Promise<{
                readonly exportFromFile: (input: string, output: string) => Promise<string>
              }>,
            catch: adapterError("session.export.import"),
          })
          yield* Effect.tryPromise({
            try: () => exporter.exportFromFile(filePath, outputPath),
            catch: adapterError("session.export.render"),
          })
          const html = yield* fs.readFileString(outputPath).pipe(Effect.mapError(adapterError("session.export.read")))
          return yield* patchExportHtml(html)
        }),
      ),
    modelCatalog,
    readModelsConfig,
    validateModelsConfig,
    saveModelsConfig,
    testModelConfig,
    oauthProviders,
    apiKeyProviders,
    apiKeyStatus,
    setApiKey,
    removeApiKey,
    oauthEvents,
    submitOAuthInput,
    logout,
    plugins: readPlugins,
    pluginAction,
    skills,
    toggleSkill,
  })
})

export const PiAgentAdapterLive: Layer.Layer<PiAgentAdapter, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =
  Layer.effect(PiAgentAdapter, adapterLive)
