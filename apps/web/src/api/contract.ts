import { Schema } from "effect"
import { JsonValue, WebSurfaceProjection } from "@pi-suite/companion-contracts/web-surface"
import {
  CandidateHash,
  SurfaceId,
  WebSurfaceActionOutcome,
  WebSurfaceActionRequest,
  WebSurfaceCatalog,
} from "@pi-suite/companion-contracts/web-surface"
export { JsonValue }
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/unstable/httpapi"

// -----------------------------------------------------------------------------
// Wire primitives
// -----------------------------------------------------------------------------

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const RuntimeId = Schema.String.pipe(Schema.brand("RuntimeId"))
export type RuntimeId = typeof RuntimeId.Type

export const RegistryId = Schema.String.pipe(Schema.brand("RegistryId"))
export type RegistryId = typeof RegistryId.Type

export const RuntimeIdentity = Schema.Struct({
  registryId: RegistryId,
  runtimeEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  runtimeId: RuntimeId,
})
export type RuntimeIdentity = typeof RuntimeIdentity.Type

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const Empty = Schema.Struct({})
export const Ok = Schema.Struct({ ok: Schema.Literal(true) })

// -----------------------------------------------------------------------------
// Public error algebra
// -----------------------------------------------------------------------------

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("InvalidInput", {
  field: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export const ConflictDetail = Schema.Union([
  Schema.TaggedStruct("DirtyWorktree", { path: Schema.String }),
  Schema.TaggedStruct("AlreadyRunning", { operation: Schema.String }),
  Schema.TaggedStruct("PendingInteraction", { interactionId: Schema.String }),
  Schema.TaggedStruct("IdempotencyConflict", {
    requestId: Schema.String,
    reason: Schema.Literals(["PayloadMismatch", "InDoubt"]),
  }),
])

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("Conflict", {
  message: Schema.String,
  detail: Schema.optionalKey(ConflictDetail),
}) {}

export class PayloadTooLarge extends Schema.TaggedErrorClass<PayloadTooLarge>()("PayloadTooLarge", {
  limitBytes: Schema.Number,
  message: Schema.String,
}) {}

export class UnsupportedPlatform extends Schema.TaggedErrorClass<UnsupportedPlatform>()("UnsupportedPlatform", {
  platform: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export class OperationFailed extends Schema.TaggedErrorClass<OperationFailed>()("OperationFailed", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const InvalidInputResponse = InvalidInput.pipe(HttpApiSchema.status("BadRequest"))
export const ForbiddenResponse = Forbidden.pipe(HttpApiSchema.status("Forbidden"))
export const NotFoundResponse = NotFound.pipe(HttpApiSchema.status("NotFound"))
export const ConflictResponse = Conflict.pipe(HttpApiSchema.status("Conflict"))
export const PayloadTooLargeResponse = PayloadTooLarge.pipe(HttpApiSchema.status("PayloadTooLarge"))
export const UnsupportedPlatformResponse = UnsupportedPlatform.pipe(HttpApiSchema.status("NotImplemented"))
export const OperationFailedResponse = OperationFailed.pipe(HttpApiSchema.status("InternalServerError"))

export const ApiErrors = [
  InvalidInputResponse,
  ForbiddenResponse,
  NotFoundResponse,
  ConflictResponse,
  PayloadTooLargeResponse,
  UnsupportedPlatformResponse,
  OperationFailedResponse,
] as const

export class SameOrigin extends HttpApiMiddleware.Service<SameOrigin>()("pi-web/api/SameOrigin", {
  error: ForbiddenResponse,
}) {}

export class RequestSchemaErrors extends HttpApiMiddleware.Service<RequestSchemaErrors>()(
  "pi-web/api/RequestSchemaErrors",
  {
    error: InvalidInputResponse,
  },
) {}

// -----------------------------------------------------------------------------
// Pi/session domain schemas
// -----------------------------------------------------------------------------

export const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export type TextContent = typeof TextContent.Type
export const ImageSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("base64"),
    media_type: Schema.String,
    data: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("url"),
    url: Schema.String,
  }),
])
export const ImageContent = Schema.Struct({ type: Schema.Literal("image"), source: ImageSource })
export type ImageContent = typeof ImageContent.Type
export const ThinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  deferred: Schema.optionalKey(Schema.Boolean),
})
export type ThinkingContent = typeof ThinkingContent.Type
export const ToolCallContent = Schema.Struct({
  type: Schema.Literal("toolCall"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Record(Schema.String, JsonValue),
})
export type ToolCallContent = typeof ToolCallContent.Type
export const AssistantContentBlock = Schema.Union([TextContent, ImageContent, ThinkingContent, ToolCallContent])
export type AssistantContentBlock = typeof AssistantContentBlock.Type

export const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
})

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContent, ImageContent]))]),
  timestamp: Schema.optionalKey(Schema.Number),
})
export type UserMessage = typeof UserMessage.Type
export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContentBlock),
  model: Schema.String,
  provider: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(Usage),
})
export type AssistantMessage = typeof AssistantMessage.Type
export const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.optionalKey(Schema.String),
  content: Schema.Array(Schema.Union([TextContent, ImageContent])),
  isError: Schema.optionalKey(Schema.Boolean),
  details: Schema.optionalKey(JsonValue),
  timestamp: Schema.optionalKey(Schema.Number),
})
export type ToolResultMessage = typeof ToolResultMessage.Type
export const CustomMessage = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContent, ImageContent]))]),
  display: Schema.Boolean,
  details: Schema.optionalKey(JsonValue),
  timestamp: Schema.optionalKey(Schema.Number),
})
export type CustomMessage = typeof CustomMessage.Type
export const BashExecutionMessage = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  fullOutputPath: Schema.optionalKey(Schema.String),
  timestamp: Schema.Number,
  excludeFromContext: Schema.optionalKey(Schema.Boolean),
})
export type BashExecutionMessage = typeof BashExecutionMessage.Type
export const AgentMessage = Schema.Union([
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  CustomMessage,
  BashExecutionMessage,
])
export type AgentMessage = typeof AgentMessage.Type

export const ActiveBashExecution = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  output: Schema.String,
  excludeFromContext: Schema.Boolean,
  startedAt: Schema.Number,
})
export type ActiveBashExecution = typeof ActiveBashExecution.Type
export const CompletedBashExecution = Schema.Struct({
  id: Schema.String,
  message: BashExecutionMessage,
})
export type CompletedBashExecution = typeof CompletedBashExecution.Type

export {
  ChromeStatusProjection,
  type ChromeStatusProjection as ChromeStatusProjectionType,
} from "@pi-suite/companion-contracts/chrome"
export {
  WeixinStatusProjection,
  type WeixinStatusProjection as WeixinStatusProjectionType,
} from "@pi-suite/companion-contracts/weixin"
export const ExtensionStatusContribution = Schema.Union([
  Schema.TaggedStruct("Text", { key: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Structured", {
    key: Schema.String,
    kind: Schema.NonEmptyString,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    value: JsonValue,
  }),
])
export type ExtensionStatusContribution = typeof ExtensionStatusContribution.Type
export const ExtensionWidgetContent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), lines: Schema.Array(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    dataUrl: Schema.String,
    alt: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
])
export type ExtensionWidgetContent = typeof ExtensionWidgetContent.Type
export const ExtensionWidgetItem = Schema.Struct({
  key: Schema.String,
  content: ExtensionWidgetContent,
  placement: Schema.Literals(["aboveEditor", "belowEditor"]),
})
export type ExtensionWidgetItem = typeof ExtensionWidgetItem.Type

export const ExtensionInteraction = Schema.Union([
  Schema.Struct({
    interactionId: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    interactionId: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    interactionId: Schema.String,
    method: Schema.Literal("input"),
    title: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    interactionId: Schema.String,
    method: Schema.Literal("editor"),
    title: Schema.String,
    prefill: Schema.optionalKey(Schema.String),
  }),
])
export type ExtensionInteraction = typeof ExtensionInteraction.Type

export const ExtensionInteractionAnswer = Schema.Union([
  Schema.TaggedStruct("Value", { value: Schema.String }),
  Schema.TaggedStruct("Confirmation", { confirmed: Schema.Boolean }),
  Schema.TaggedStruct("Cancelled", {}),
])
export type ExtensionInteractionAnswer = typeof ExtensionInteractionAnswer.Type
export const ExtensionInteractionResponse = Schema.Struct({ answer: ExtensionInteractionAnswer })
export type ExtensionInteractionResponse = typeof ExtensionInteractionResponse.Type

export const ExtensionUiProjection = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pendingInteraction: Schema.NullOr(ExtensionInteraction),
  statuses: Schema.Array(ExtensionStatusContribution),
  widgets: Schema.Array(ExtensionWidgetItem),
  webSurfaces: Schema.Array(WebSurfaceProjection),
})
export type ExtensionUiProjection = typeof ExtensionUiProjection.Type

export const SessionEntryBase = {
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
}
export const SessionEntry = Schema.Union([
  Schema.Struct({ ...SessionEntryBase, type: Schema.Literal("message"), message: AgentMessage }),
  Schema.Struct({ ...SessionEntryBase, type: Schema.Literal("thinking_level_change"), thinkingLevel: Schema.String }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("model_change"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("compaction"),
    summary: Schema.String,
    firstKeptEntryId: Schema.String,
    tokensBefore: Schema.Number,
    details: Schema.optionalKey(JsonValue),
    fromHook: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("branch_summary"),
    fromId: Schema.String,
    summary: Schema.String,
    details: Schema.optionalKey(JsonValue),
    fromHook: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("custom"),
    customType: Schema.String,
    data: Schema.optionalKey(JsonValue),
  }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("custom_message"),
    customType: Schema.String,
    content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContent, ImageContent]))]),
    details: Schema.optionalKey(JsonValue),
    display: Schema.Boolean,
  }),
  Schema.Struct({
    ...SessionEntryBase,
    type: Schema.Literal("label"),
    targetId: Schema.String,
    label: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...SessionEntryBase, type: Schema.Literal("session_info"), name: Schema.optionalKey(Schema.String) }),
])
export type SessionEntry = typeof SessionEntry.Type

export const SessionBranchNode = Schema.Struct({
  entryId: Schema.String,
  parentNodeId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  kind: Schema.String,
  role: Schema.optionalKey(Schema.String),
  label: Schema.String,
  compressedCount: Schema.Int,
  active: Schema.Boolean,
})
export type SessionBranchNode = typeof SessionBranchNode.Type

export const SessionInfo = Schema.Struct({
  path: Schema.String,
  id: Schema.String,
  cwd: Schema.String,
  name: Schema.optionalKey(Schema.String),
  created: Schema.String,
  modified: Schema.String,
  messageCount: Schema.Number,
  firstMessage: Schema.String,
  parentSessionId: Schema.optionalKey(Schema.String),
  projectRoot: Schema.optionalKey(Schema.String),
  worktreeBranch: Schema.optionalKey(Schema.String),
})
export type SessionInfo = typeof SessionInfo.Type

export const PromptRequestReceipt = Schema.Struct({
  requestId: Schema.String,
  runId: RunId,
  userEntryId: Schema.optionalKey(Schema.String),
  assistantEntryId: Schema.optionalKey(Schema.String),
})

export const SessionContext = Schema.Struct({
  messages: Schema.Array(AgentMessage),
  entryIds: Schema.Array(Schema.String),
  promptRequests: Schema.Array(PromptRequestReceipt),
  thinkingLevel: Schema.String,
  model: Schema.NullOr(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
})
export type SessionContext = typeof SessionContext.Type

export const SessionContextPage = Schema.Struct({
  context: SessionContext,
  beforeEntryId: Schema.NullOr(Schema.String),
  hasMoreBefore: Schema.Boolean,
})
export type SessionContextPage = typeof SessionContextPage.Type

export const ContextUsage = Schema.Struct({
  percent: Schema.NullOr(Schema.Number),
  contextWindow: Schema.Number,
  tokens: Schema.NullOr(Schema.Number),
})
export const QueuedMessages = Schema.Struct({
  steering: Schema.Array(Schema.String),
  followUp: Schema.Array(Schema.String),
})
export const OperationKind = Schema.Literals(["prompt", "bash", "compaction", "slash-command"])
export const OperationSlot = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Starting", { kind: OperationKind, operationId: Schema.NonEmptyString }),
  Schema.TaggedStruct("Active", { kind: OperationKind, operationId: Schema.NonEmptyString }),
])
export type OperationSlot = typeof OperationSlot.Type
export const RuntimeSnapshot = Schema.Struct({
  identity: RuntimeIdentity,
  runId: Schema.NullOr(RunId),
  sessionId: Schema.String,
  sessionFile: Schema.String,
  operation: OperationSlot,
  activeBashExecution: Schema.NullOr(ActiveBashExecution),
  completedBashExecution: Schema.NullOr(CompletedBashExecution),
  autoCompactionEnabled: Schema.Boolean,
  autoRetryEnabled: Schema.Boolean,
  model: Schema.optionalKey(Schema.Struct({ id: Schema.String, provider: Schema.String })),
  pendingMessageCount: Schema.Number,
  queuedMessages: QueuedMessages,
  contextUsage: Schema.NullOr(ContextUsage),
  systemPrompt: Schema.String,
  thinkingLevel: Schema.String,
  extensionUi: ExtensionUiProjection,
})

export const SessionSnapshot = Schema.Struct({
  sessionId: Schema.String,
  filePath: Schema.String,
  info: Schema.NullOr(SessionInfo),
  leafId: Schema.NullOr(Schema.String),
  branchNodes: Schema.Array(SessionBranchNode),
  context: SessionContext,
  contextPage: Schema.Struct({
    beforeEntryId: Schema.NullOr(Schema.String),
    hasMoreBefore: Schema.Boolean,
  }),
  runtime: Schema.NullOr(RuntimeSnapshot),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export const SessionIndex = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
  runningSessionIds: Schema.Array(Schema.String),
})
export type SessionIndex = typeof SessionIndex.Type

export const RunScopedEvent = Schema.Union([
  Schema.TaggedStruct("RunStarted", { runId: RunId }),
  Schema.TaggedStruct("RunFinished", { runId: RunId }),
  Schema.TaggedStruct("RunFailed", { runId: RunId, message: Schema.String }),
  Schema.TaggedStruct("MessageStarted", { runId: RunId, message: AgentMessage }),
  Schema.TaggedStruct("MessageUpdated", { runId: RunId, message: AgentMessage }),
  Schema.TaggedStruct("MessageFinished", { eventId: Schema.String, runId: RunId, message: AgentMessage }),
  Schema.TaggedStruct("ToolStarted", { runId: RunId, toolCallId: Schema.String, toolName: Schema.String }),
  Schema.TaggedStruct("ToolFinished", { runId: RunId, toolCallId: Schema.String }),
  Schema.TaggedStruct("QueueChanged", { runId: RunId, queued: QueuedMessages }),
  Schema.TaggedStruct("RetryStarted", {
    runId: RunId,
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    errorMessage: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("RetryFinished", { runId: RunId }),
  Schema.TaggedStruct("CompactionStarted", { runId: RunId }),
  Schema.TaggedStruct("CompactionFinished", {
    runId: RunId,
    aborted: Schema.Boolean,
    errorMessage: Schema.optionalKey(Schema.String),
    tokensBefore: Schema.optionalKey(Schema.Number),
    estimatedTokensAfter: Schema.optionalKey(Schema.Number),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("BashStarted", { runId: RunId, execution: ActiveBashExecution }),
  Schema.TaggedStruct("BashOutput", { runId: RunId, id: Schema.String, chunk: Schema.String }),
  Schema.TaggedStruct("BashFinished", { runId: RunId, execution: CompletedBashExecution }),
  Schema.TaggedStruct("BashFailed", { runId: RunId, id: Schema.String, message: Schema.String }),
])
export type RunScopedEvent = typeof RunScopedEvent.Type

export const SessionScopedEvent = Schema.Union([
  Schema.TaggedStruct("RuntimeActivated", { projection: ExtensionUiProjection }),
  Schema.TaggedStruct("ExtensionUiChanged", { projection: ExtensionUiProjection }),
  Schema.TaggedStruct("ExtensionNotice", {
    noticeId: Schema.String,
    message: Schema.String,
    notifyType: Schema.Literals(["info", "warning", "error"]),
  }),
  Schema.TaggedStruct("ExtensionFailed", { message: Schema.String }),
])
export type SessionScopedEvent = typeof SessionScopedEvent.Type

export const RuntimeEnvelope = Schema.Struct({
  identity: RuntimeIdentity,
  event: Schema.Union([RunScopedEvent, SessionScopedEvent]),
})
export type RuntimeEnvelope = typeof RuntimeEnvelope.Type

export const PromptProgressEvent = Schema.Union([
  Schema.TaggedStruct("ToolStarted", {
    runId: RunId,
    toolCallId: Schema.String,
    toolName: Schema.String,
  }),
  Schema.TaggedStruct("Completed", { runId: RunId, text: Schema.String }),
])
export type PromptProgressEvent = typeof PromptProgressEvent.Type

export const RunningSessionsEvent = Schema.TaggedStruct("RunningSessionsChanged", {
  sessionIds: Schema.Array(Schema.String),
})

// -----------------------------------------------------------------------------
// Workspace / catalog / package schemas
// -----------------------------------------------------------------------------

export const FileKind = Schema.Literals(["file", "directory"])
export const FileNode = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: FileKind,
  size: Schema.optionalKey(Schema.Number),
  modified: Schema.optionalKey(Schema.String),
})
export const FileContent = Schema.Struct({
  path: Schema.String,
  contentType: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  size: Schema.Number,
  modified: Schema.String,
})
export const FileMeta = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  modified: Schema.String,
  contentType: Schema.String,
})
export const FileWatchEvent = Schema.Union([
  Schema.TaggedStruct("Changed", { path: Schema.String, modified: Schema.String, size: Schema.Number }),
  Schema.TaggedStruct("Removed", { path: Schema.String }),
])
export const Attachment = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  data: Schema.String,
})
export const StoredAttachment = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
})

export const WorktreeInfo = Schema.Struct({
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isMain: Schema.Boolean,
})
export const ProjectInfo = Schema.Struct({
  projectRoot: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isWorktree: Schema.Boolean,
  isTopLevel: Schema.Boolean,
})

export const ModelEntry = Schema.Struct({ id: Schema.String, name: Schema.String, provider: Schema.String })
export const ModelCatalog = Schema.Struct({
  models: Schema.Record(Schema.String, Schema.String),
  modelList: Schema.Array(ModelEntry),
  defaultModel: Schema.NullOr(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
  thinkingLevels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  thinkingLevelMaps: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
})
const ModelCostTier = Schema.Struct({
  inputTokensAbove: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})
const ModelCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  tiers: Schema.optionalKey(Schema.Array(ModelCostTier)),
})
const ModelCostOverride = Schema.Struct({
  input: Schema.optionalKey(Schema.Finite),
  output: Schema.optionalKey(Schema.Finite),
  cacheRead: Schema.optionalKey(Schema.Finite),
  cacheWrite: Schema.optionalKey(Schema.Finite),
  tiers: Schema.optionalKey(Schema.Array(ModelCostTier)),
})
const ModelInput = Schema.Union([Schema.Literal("text"), Schema.Literal("image")])
const ModelOverride = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Boolean),
  thinkingLevelMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  input: Schema.optionalKey(Schema.Array(ModelInput)),
  cost: Schema.optionalKey(ModelCostOverride),
  contextWindow: Schema.optionalKey(Schema.Finite),
  maxTokens: Schema.optionalKey(Schema.Finite),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  compat: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
})
export const ModelConfigEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  api: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Boolean),
  thinkingLevelMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  input: Schema.optionalKey(Schema.Array(ModelInput)),
  contextWindow: Schema.optionalKey(Schema.Finite),
  maxTokens: Schema.optionalKey(Schema.Finite),
  cost: Schema.optionalKey(ModelCost),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  compat: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
})
export const ProviderConfigEntry = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  api: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  compat: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
  authHeader: Schema.optionalKey(Schema.Boolean),
  models: Schema.optionalKey(Schema.Array(ModelConfigEntry)),
  modelOverrides: Schema.optionalKey(Schema.Record(Schema.String, ModelOverride)),
})
export const ModelsConfig = Schema.Struct({
  providers: Schema.Record(Schema.String, ProviderConfigEntry),
})
export const ModelConfigValidation = Schema.Union([
  Schema.Struct({ valid: Schema.Literal(true) }),
  Schema.Struct({ valid: Schema.Literal(false), error: Schema.String }),
])
export const ModelTestResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  latencyMs: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.Number),
  responseText: Schema.optionalKey(Schema.String),
})

export const OAuthProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  loggedIn: Schema.Boolean,
})
export const ApiKeyProvider = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  configured: Schema.Boolean,
  source: Schema.optionalKey(Schema.String),
  modelCount: Schema.Number,
})
export const ApiKeyStatus = Schema.Struct({
  provider: Schema.String,
  displayName: Schema.String,
  configured: Schema.Boolean,
  source: Schema.optionalKey(Schema.String),
  models: Schema.Number,
})
export const OAuthEvent = Schema.Union([
  Schema.TaggedStruct("Auth", {
    url: Schema.String,
    instructions: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("DeviceCode", {
    userCode: Schema.String,
    verificationUri: Schema.String,
    intervalSeconds: Schema.NullOr(Schema.Number),
    expiresInSeconds: Schema.NullOr(Schema.Number),
  }),
  Schema.TaggedStruct("Prompt", {
    message: Schema.String,
    placeholder: Schema.NullOr(Schema.String),
    token: Schema.String,
  }),
  Schema.TaggedStruct("Select", {
    message: Schema.String,
    options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    token: Schema.String,
  }),
  Schema.TaggedStruct("Progress", { message: Schema.String }),
  Schema.TaggedStruct("Succeeded", {}),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
])

export const SkillSearchResult = Schema.Struct({
  package: Schema.String,
  installs: Schema.String,
  url: Schema.String,
})
export type SkillSearchResult = typeof SkillSearchResult.Type
export const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  baseDir: Schema.String,
  disableModelInvocation: Schema.Boolean,
  sourceInfo: Schema.Struct({
    source: Schema.optionalKey(Schema.String),
    scope: Schema.optionalKey(Schema.String),
  }),
})
export const SkillDiagnostic = Schema.Struct({
  type: Schema.Literals(["warning", "error"]),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
})
export const SkillsResponse = Schema.Struct({
  skills: Schema.Array(SkillInfo),
  diagnostics: Schema.Array(SkillDiagnostic),
})
export const SkillFileEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
  size: Schema.Number,
})
export const SkillFileContent = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  size: Schema.Number,
})

export const PluginScope = Schema.Literals(["global", "project"])
export const PluginResourceKind = Schema.Literals(["extension", "skill", "prompt", "theme"])
export const PluginResourceCounts = Schema.Struct({
  extensions: Schema.Number,
  skills: Schema.Number,
  prompts: Schema.Number,
  themes: Schema.Number,
})
export const PluginDiagnostic = Schema.Struct({
  type: Schema.Literals(["warning", "error"]),
  message: Schema.String,
  source: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
})
export const PluginResourceInfo = Schema.Struct({
  kind: PluginResourceKind,
  name: Schema.String,
  path: Schema.String,
  relativePath: Schema.String,
})
export const PluginPackageInfo = Schema.Struct({
  source: Schema.String,
  scope: PluginScope,
  ownerCwd: Schema.optionalKey(Schema.String),
  filtered: Schema.Boolean,
  disabled: Schema.Boolean,
  installedPath: Schema.optionalKey(Schema.String),
  packageName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  configuredVersion: Schema.optionalKey(Schema.String),
  counts: PluginResourceCounts,
  resources: Schema.Array(PluginResourceInfo),
  status: Schema.Literals(["loaded", "installed", "missing", "disabled"]),
})
export type PluginPackageInfo = typeof PluginPackageInfo.Type
export const PluginsResponse = Schema.Struct({
  packages: Schema.Array(PluginPackageInfo),
  totals: PluginResourceCounts,
  diagnostics: Schema.Array(PluginDiagnostic),
})
export type PluginsResponse = typeof PluginsResponse.Type
export const PluginUpdateInfo = Schema.Struct({
  source: Schema.String,
  scope: PluginScope,
  ownerCwd: Schema.optionalKey(Schema.String),
  updateAvailable: Schema.Boolean,
})
export type PluginUpdateInfo = typeof PluginUpdateInfo.Type
export const PluginUpdatesResponse = Schema.Struct({ updates: Schema.Array(PluginUpdateInfo) })
export type PluginUpdatesResponse = typeof PluginUpdatesResponse.Type

export const ToolEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  active: Schema.Boolean,
})
export const SlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  source: Schema.Literals(["extension", "prompt", "skill"]),
  sourceInfo: JsonValue,
})
export const SessionStats = Schema.Struct({
  sessionFile: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  sessionName: Schema.optionalKey(Schema.String),
  userMessages: Schema.Number,
  assistantMessages: Schema.Number,
  toolCalls: Schema.Number,
  toolResults: Schema.Number,
  totalMessages: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
  cost: Schema.Number,
  contextUsage: Schema.optionalKey(ContextUsage),
})
export type SessionStats = typeof SessionStats.Type

// -----------------------------------------------------------------------------
// API groups
// -----------------------------------------------------------------------------

const IdParam = { id: Schema.String }
const ProviderParam = { provider: Schema.String }
const CommonErrors = ApiErrors

const MetaApi = HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("health", "/api/health", {
    success: Schema.Struct({
      status: Schema.Literal("ok"),
      appVersion: Schema.String,
      piVersion: Schema.String,
    }),
  }),
  HttpApiEndpoint.get("version", "/api/meta/version", {
    success: Schema.Struct({ appVersion: Schema.String, piVersion: Schema.String }),
  }),
)

const SessionsApi = HttpApiGroup.make("sessions").add(
  HttpApiEndpoint.get("list", "/api/sessions", { success: SessionIndex, error: CommonErrors }),
  HttpApiEndpoint.post("create", "/api/sessions", {
    payload: Schema.Struct({
      cwd: Schema.String,
      toolNames: Schema.optionalKey(Schema.Array(Schema.String)),
      model: Schema.optionalKey(
        Schema.Struct({
          provider: Schema.NonEmptyString,
          modelId: Schema.NonEmptyString,
        }),
      ),
    }),
    success: SessionInfo,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("snapshot", "/api/sessions/:id", {
    params: IdParam,
    query: {
      deferThinking: Schema.optionalKey(Schema.String),
      deferMedia: Schema.optionalKey(Schema.String),
    },
    success: SessionSnapshot,
    error: CommonErrors,
  }),
  HttpApiEndpoint.patch("rename", "/api/sessions/:id", {
    params: IdParam,
    payload: Schema.Struct({ name: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.delete("remove", "/api/sessions/:id", {
    params: IdParam,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("context", "/api/sessions/:id/context", {
    params: IdParam,
    query: {
      leafId: Schema.optionalKey(Schema.String),
      beforeEntryId: Schema.optionalKey(Schema.String),
      deferThinking: Schema.optionalKey(Schema.String),
      deferMedia: Schema.optionalKey(Schema.String),
    },
    success: SessionContextPage,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("thinking", "/api/sessions/:id/thinking", {
    params: IdParam,
    query: { entryId: Schema.String, blockIndex: Schema.NumberFromString },
    success: Schema.Struct({ thinking: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("export", "/api/sessions/:id/export", {
    params: IdParam,
    success: HttpApiSchema.StreamUint8Array({ contentType: "text/html; charset=utf-8" }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("events", "/api/sessions/:id/events", {
    params: IdParam,
    success: HttpApiSchema.StreamSse({ data: RuntimeEnvelope, error: OperationFailed }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("runningEvents", "/api/sessions/running/events", {
    success: HttpApiSchema.StreamSse({ data: RunningSessionsEvent, error: OperationFailed }),
    error: CommonErrors,
  }),
)

const ImageInput = Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String })
const MessagePayload = Schema.Struct({
  message: Schema.String,
  images: Schema.optionalKey(Schema.Array(ImageInput)),
})

const IdempotencyKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const SessionActionsApi = HttpApiGroup.make("sessionActions").add(
  HttpApiEndpoint.post("prompt", "/api/sessions/:id/actions/prompt", {
    params: IdParam,
    payload: Schema.Struct({
      requestId: IdempotencyKey,
      message: Schema.String,
      images: Schema.optionalKey(Schema.Array(ImageInput)),
    }),
    success: Schema.Struct({ requestId: IdempotencyKey, runId: RunId }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("promptProgress", "/api/sessions/:id/actions/prompt-progress", {
    params: IdParam,
    payload: Schema.Struct({ ...MessagePayload.fields, requestId: IdempotencyKey }),
    success: HttpApiSchema.StreamSse({ data: PromptProgressEvent, error: OperationFailed }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("steer", "/api/sessions/:id/actions/steer", {
    params: IdParam,
    payload: MessagePayload,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("followUp", "/api/sessions/:id/actions/follow-up", {
    params: IdParam,
    payload: MessagePayload,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("abort", "/api/sessions/:id/actions/abort", {
    params: IdParam,
    payload: Empty,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("fork", "/api/sessions/:id/actions/fork", {
    params: IdParam,
    payload: Schema.Struct({ entryId: Schema.String }),
    success: Schema.Struct({ cancelled: Schema.Boolean, newSessionId: Schema.optionalKey(Schema.String) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("navigate", "/api/sessions/:id/actions/navigate", {
    params: IdParam,
    payload: Schema.Struct({ targetId: Schema.String }),
    success: Schema.Struct({ cancelled: Schema.Boolean }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("compact", "/api/sessions/:id/actions/compact", {
    params: IdParam,
    payload: Schema.Struct({ customInstructions: Schema.optionalKey(Schema.String) }),
    success: Schema.Struct({ runId: RunId }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("abortCompaction", "/api/sessions/:id/actions/abort-compaction", {
    params: IdParam,
    payload: Empty,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("bash", "/api/sessions/:id/actions/bash", {
    params: IdParam,
    payload: Schema.Struct({ id: Schema.String, command: Schema.String, excludeFromContext: Schema.Boolean }),
    success: Schema.Struct({ runId: RunId }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("abortBash", "/api/sessions/:id/actions/abort-bash", {
    params: IdParam,
    payload: Empty,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setModel", "/api/sessions/:id/actions/model", {
    params: IdParam,
    payload: Schema.Struct({ provider: Schema.String, modelId: Schema.String }),
    success: Schema.Struct({ id: Schema.String, provider: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setThinking", "/api/sessions/:id/actions/thinking", {
    params: IdParam,
    payload: Schema.Struct({ level: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setTools", "/api/sessions/:id/actions/tools", {
    params: IdParam,
    payload: Schema.Struct({ toolNames: Schema.Array(Schema.String) }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("tools", "/api/sessions/:id/tools", {
    params: IdParam,
    success: Schema.Struct({ tools: Schema.Array(ToolEntry) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("commands", "/api/sessions/:id/commands", {
    params: IdParam,
    success: Schema.Struct({ commands: Schema.Array(SlashCommand) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("stats", "/api/sessions/:id/stats", {
    params: IdParam,
    success: SessionStats,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("lastAssistant", "/api/sessions/:id/last-assistant", {
    params: IdParam,
    success: Schema.Struct({ text: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setAutoCompaction", "/api/sessions/:id/actions/auto-compaction", {
    params: IdParam,
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setAutoRetry", "/api/sessions/:id/actions/auto-retry", {
    params: IdParam,
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("clearQueue", "/api/sessions/:id/actions/clear-queue", {
    params: IdParam,
    payload: Empty,
    success: QueuedMessages,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("reload", "/api/sessions/:id/actions/reload", {
    params: IdParam,
    payload: Empty,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("slashCommand", "/api/sessions/:id/actions/slash-command", {
    params: IdParam,
    payload: Schema.Struct({ name: Schema.NonEmptyString, args: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post(
    "resolveInteraction",
    "/api/sessions/:id/runtimes/:runtimeId/interactions/:interactionId/resolve",
    {
      params: Schema.Struct({ id: Schema.String, runtimeId: RuntimeId, interactionId: Schema.String }),
      payload: ExtensionInteractionResponse,
      success: Ok,
      error: CommonErrors,
    },
  ),
)

const WorkspaceApi = HttpApiGroup.make("workspace").add(
  HttpApiEndpoint.get("home", "/api/workspace/home", {
    success: Schema.Struct({ home: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("validateCwd", "/api/workspace/cwd/validate", {
    payload: Schema.Struct({ cwd: Schema.String }),
    success: Schema.Struct({ cwd: Schema.String, project: ProjectInfo }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("pickCwd", "/api/workspace/cwd/pick", {
    payload: Empty,
    success: Schema.Struct({ cwd: Schema.NullOr(Schema.String) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("defaultCwd", "/api/workspace/cwd/default", {
    payload: Empty,
    success: Schema.Struct({ cwd: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("fileIndex", "/api/workspace/files", {
    query: {
      root: Schema.String,
      query: Schema.optionalKey(Schema.String),
      deep: Schema.optionalKey(Schema.Literal("1")),
      sessionId: Schema.optionalKey(Schema.String),
    },
    success: Schema.Struct({ entries: Schema.Array(FileNode), truncated: Schema.Boolean }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("readFile", "/api/workspace/files/read", {
    query: { path: Schema.String, sessionId: Schema.optionalKey(Schema.String) },
    success: FileContent,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("fileMeta", "/api/workspace/files/meta", {
    query: { path: Schema.String, sessionId: Schema.optionalKey(Schema.String) },
    success: FileMeta,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("previewFile", "/api/workspace/files/preview", {
    query: { path: Schema.String, sessionId: Schema.optionalKey(Schema.String) },
    success: FileContent,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("watchFile", "/api/workspace/files/watch", {
    query: { path: Schema.String, sessionId: Schema.optionalKey(Schema.String) },
    success: HttpApiSchema.StreamSse({ data: FileWatchEvent, error: OperationFailed }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("downloadFile", "/api/workspace/files/download", {
    query: { path: Schema.String, sessionId: Schema.optionalKey(Schema.String) },
    success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("attachments", "/api/workspace/attachments", {
    payload: Schema.Struct({ cwd: Schema.String, attachments: Schema.Array(Attachment) }),
    success: Schema.Struct({ attachments: Schema.Array(StoredAttachment) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("worktrees", "/api/workspace/worktrees", {
    query: { cwd: Schema.String },
    success: Schema.Struct({ worktrees: Schema.Array(WorktreeInfo), project: ProjectInfo }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("createWorktree", "/api/workspace/worktrees", {
    payload: Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
    success: Schema.Struct({ path: Schema.String, branch: Schema.String }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.delete("removeWorktree", "/api/workspace/worktrees", {
    payload: Schema.Struct({ cwd: Schema.String, path: Schema.String, force: Schema.Boolean }),
    success: Ok,
    error: CommonErrors,
  }),
)

const ModelsApi = HttpApiGroup.make("models").add(
  HttpApiEndpoint.get("catalog", "/api/models", {
    query: { cwd: Schema.String },
    success: ModelCatalog,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("config", "/api/models/config", { success: ModelsConfig, error: CommonErrors }),
  HttpApiEndpoint.post("validateConfig", "/api/models/config/validate", {
    payload: ModelsConfig,
    success: ModelConfigValidation,
    error: CommonErrors,
  }),
  HttpApiEndpoint.put("saveConfig", "/api/models/config", {
    payload: ModelsConfig,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("testConfig", "/api/models/config/test", {
    payload: Schema.Struct({ providerName: Schema.String, provider: JsonValue, model: JsonValue }),
    success: ModelTestResult,
    error: CommonErrors,
  }),
)

const AuthApi = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("oauthProviders", "/api/auth/oauth/providers", {
    success: Schema.Struct({ providers: Schema.Array(OAuthProvider) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("apiKeyProviders", "/api/auth/api-key/providers", {
    success: Schema.Struct({ providers: Schema.Array(ApiKeyProvider) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("apiKeyStatus", "/api/auth/api-key/:provider", {
    params: ProviderParam,
    success: ApiKeyStatus,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("setApiKey", "/api/auth/api-key/:provider", {
    params: ProviderParam,
    payload: Schema.Struct({ apiKey: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.delete("removeApiKey", "/api/auth/api-key/:provider", {
    params: ProviderParam,
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("oauthEvents", "/api/auth/oauth/:provider/events", {
    params: ProviderParam,
    success: HttpApiSchema.StreamSse({ data: OAuthEvent, error: OperationFailed }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("submitOAuthInput", "/api/auth/oauth/:provider/input", {
    params: ProviderParam,
    payload: Schema.Struct({ token: Schema.String, code: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("logout", "/api/auth/oauth/:provider/logout", {
    params: ProviderParam,
    payload: Empty,
    success: Ok,
    error: CommonErrors,
  }),
)

const PackagesApi = HttpApiGroup.make("packages").add(
  HttpApiEndpoint.get("pluginOverview", "/api/packages/plugins/overview", {
    success: PluginsResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("pluginUpdates", "/api/packages/plugins/updates", {
    success: PluginUpdatesResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("globalPlugins", "/api/packages/plugins/global", {
    success: PluginsResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("plugins", "/api/packages/plugins", {
    query: { cwd: Schema.String },
    success: PluginsResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("pluginAction", "/api/packages/plugins/actions", {
    payload: Schema.Struct({
      cwd: Schema.optionalKey(Schema.String),
      action: Schema.Literals(["install", "remove", "update", "disable", "enable"]),
      source: Schema.optionalKey(Schema.String),
      scope: Schema.optionalKey(PluginScope),
    }),
    success: PluginsResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("skills", "/api/packages/skills", {
    query: { cwd: Schema.String },
    success: SkillsResponse,
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("skillFiles", "/api/packages/skills/files", {
    query: { cwd: Schema.String, skillPath: Schema.String },
    success: Schema.Struct({ entries: Schema.Array(SkillFileEntry) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.get("skillFile", "/api/packages/skills/file", {
    query: { cwd: Schema.String, skillPath: Schema.String, path: Schema.String },
    success: SkillFileContent,
    error: CommonErrors,
  }),
  HttpApiEndpoint.patch("toggleSkill", "/api/packages/skills", {
    payload: Schema.Struct({ cwd: Schema.String, filePath: Schema.String, disableModelInvocation: Schema.Boolean }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.delete("deleteSkill", "/api/packages/skills", {
    payload: Schema.Struct({ cwd: Schema.String, filePath: Schema.String }),
    success: Ok,
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("searchSkills", "/api/packages/skills/search", {
    payload: Schema.Struct({ query: Schema.String, limit: Schema.optionalKey(Schema.Number) }),
    success: Schema.Struct({ results: Schema.Array(SkillSearchResult) }),
    error: CommonErrors,
  }),
  HttpApiEndpoint.post("installSkill", "/api/packages/skills/install", {
    payload: Schema.Union([
      Schema.Struct({ package: Schema.String, scope: Schema.Literal("global") }),
      Schema.Struct({ package: Schema.String, scope: Schema.Literal("project"), cwd: Schema.String }),
    ]),
    success: Schema.Struct({ output: Schema.String }),
    error: CommonErrors,
  }),
)

const WebSurfacesApi = HttpApiGroup.make("webSurfaces")
  .add(
    HttpApiEndpoint.get("catalog", "/api/sessions/:id/web-surfaces", {
      params: IdParam,
      success: WebSurfaceCatalog,
      error: CommonErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "downloadBrowserCompanion",
      "/api/sessions/:id/web-surfaces/:surfaceId/:candidateHash/browser-companion.zip",
      {
        params: Schema.Struct({
          id: Schema.String,
          surfaceId: SurfaceId,
          candidateHash: CandidateHash,
        }),
        success: HttpApiSchema.StreamUint8Array({ contentType: "application/zip" }),
        error: CommonErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "dispatch",
      "/api/sessions/:id/runtimes/:runtimeId/web-surfaces/:surfaceId/:candidateHash/actions",
      {
        params: Schema.Struct({
          id: Schema.String,
          runtimeId: RuntimeId,
          surfaceId: SurfaceId,
          candidateHash: CandidateHash,
        }),
        payload: WebSurfaceActionRequest,
        success: WebSurfaceActionOutcome,
        error: CommonErrors,
      },
    ),
  )

export const PiWebApi = HttpApi.make("PiWebApi")
  .add(MetaApi, SessionsApi, SessionActionsApi, WorkspaceApi, ModelsApi, AuthApi, PackagesApi, WebSurfacesApi)
  .middleware(SameOrigin)
  .middleware(RequestSchemaErrors)
