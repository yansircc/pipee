import { ActiveBashExecution, ExtensionUiProjection, RuntimeIdentity, RuntimeSnapshot } from "@/api/contract"
import type {
  AgentMessage,
  RunScopedEvent,
  SessionContextPage,
  SessionScopedEvent,
  SessionSnapshot,
  UserMessage,
} from "@/api/contract"

type ActiveBashExecutionValue = typeof ActiveBashExecution.Type
type ExtensionUiProjectionValue = typeof ExtensionUiProjection.Type
type RuntimeIdentityValue = typeof RuntimeIdentity.Type
type RuntimeSnapshotValue = typeof RuntimeSnapshot.Type
export type OperationKind = "prompt" | "bash" | "compaction"

export interface SessionUiState {
  readonly sessionId: string | null
  readonly runtimeIdentity: RuntimeIdentityValue | null
  readonly chromeControlOperation: {
    readonly requestId: string
    readonly enabled: boolean
  } | null
  readonly snapshotRequestId: number
  readonly contextRequestId: number
  readonly snapshot: SessionSnapshot | null
  readonly messages: ReadonlyArray<AgentMessage>
  readonly entryIds: ReadonlyArray<string>
  readonly pendingPrompt: {
    readonly requestId: string
    readonly runId: string | null
    readonly message: UserMessage
  } | null
  readonly ephemeralMessages: ReadonlyArray<{
    readonly eventId: string
    readonly runId: string
    readonly message: AgentMessage
  }>
  readonly runId: string | null
  readonly terminalRunId: string | null
  readonly completionRunId: string | null
  readonly pendingOperation: OperationKind | null
  readonly isStreaming: boolean
  readonly streamingMessage: AgentMessage | null
  readonly agentRunning: boolean
  readonly activeBashExecution: ActiveBashExecutionValue | null
  readonly retryInfo: { readonly attempt: number; readonly maxAttempts: number; readonly errorMessage?: string } | null
  readonly queuedMessages: { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
  readonly extensionUi: ExtensionUiProjectionValue
  readonly isCompacting: boolean
  readonly compactResult: {
    readonly reason: string
    readonly tokensBefore: number
    readonly estimatedTokensAfter: number
  } | null
  readonly error: string | null
}

export const initialSessionUiState: SessionUiState = {
  sessionId: null,
  runtimeIdentity: null,
  chromeControlOperation: null,
  snapshotRequestId: 0,
  contextRequestId: 0,
  snapshot: null,
  messages: [],
  entryIds: [],
  pendingPrompt: null,
  ephemeralMessages: [],
  runId: null,
  terminalRunId: null,
  completionRunId: null,
  pendingOperation: null,
  isStreaming: false,
  streamingMessage: null,
  agentRunning: false,
  activeBashExecution: null,
  retryInfo: null,
  queuedMessages: { steering: [], followUp: [] },
  extensionUi: ExtensionUiProjection.make({
    revision: 0,
    pendingInteraction: null,
    statuses: [],
    widgets: [],
  }),
  isCompacting: false,
  compactResult: null,
  error: null,
}

export type SessionUiAction =
  | {
      readonly _tag: "Loaded"
      readonly sessionId: string
      readonly requestId: number
      readonly snapshot: SessionSnapshot
    }
  | { readonly _tag: "ContextRequested"; readonly sessionId: string; readonly requestId: number }
  | {
      readonly _tag: "ContextLoaded"
      readonly sessionId: string
      readonly requestId: number
      readonly context: SessionSnapshot["context"]
      readonly leafId: string | null
      readonly page: Pick<SessionContextPage, "beforeEntryId" | "hasMoreBefore">
    }
  | {
      readonly _tag: "ContextPrepended"
      readonly sessionId: string
      readonly requestId: number
      readonly page: SessionContextPage
    }
  | { readonly _tag: "LoadFailed"; readonly sessionId: string; readonly message: string }
  | { readonly _tag: "OperationPending"; readonly sessionId: string | null; readonly kind: OperationKind }
  | {
      readonly _tag: "OperationAccepted"
      readonly sessionId: string
      readonly kind: OperationKind
      readonly runId: string
    }
  | { readonly _tag: "PromptAccepted"; readonly sessionId: string; readonly requestId: string; readonly runId: string }
  | {
      readonly _tag: "OperationFailed"
      readonly sessionId: string | null
      readonly kind: OperationKind
      readonly message: string
    }
  | { readonly _tag: "PromptSubmitted"; readonly requestId: string; readonly message: UserMessage }
  | { readonly _tag: "ChromeControlRequested"; readonly requestId: string; readonly enabled: boolean }
  | {
      readonly _tag: "ChromeControlSucceeded"
      readonly requestId: string
    }
  | { readonly _tag: "ChromeControlFailed"; readonly requestId: string }
  | {
      readonly _tag: "RuntimeEvent"
      readonly sessionId: string
      readonly identity: RuntimeIdentityValue
      readonly event: RunScopedEvent | SessionScopedEvent
    }
  | { readonly _tag: "Reset"; readonly sessionId: string }

const appendEphemeral = (
  messages: SessionUiState["ephemeralMessages"],
  eventId: string,
  runId: string,
  message: AgentMessage,
): SessionUiState["ephemeralMessages"] =>
  messages.some((item) => item.eventId === eventId) ? messages : [...messages, { eventId, runId, message }]

const promptReceipt = (pendingPrompt: SessionUiState["pendingPrompt"], context: SessionSnapshot["context"]) =>
  pendingPrompt === null ? undefined : context.promptRequests.find((item) => item.requestId === pendingPrompt.requestId)

const activeRunId = (state: SessionUiState): string | null => {
  if (state.pendingPrompt !== null) return state.pendingPrompt.runId
  if (
    state.runId === null ||
    state.runId === state.terminalRunId ||
    (!state.agentRunning && !state.isStreaming && !state.isCompacting && state.activeBashExecution === null)
  )
    return null
  return state.runId
}

const sameRuntimeIdentity = (left: RuntimeIdentityValue, right: RuntimeIdentityValue): boolean =>
  left.registryId === right.registryId && left.runtimeEpoch === right.runtimeEpoch && left.runtimeId === right.runtimeId

const installRuntimeIdentity = (
  state: SessionUiState,
  identity: RuntimeIdentityValue,
  extensionUi: ExtensionUiProjectionValue,
): SessionUiState => ({
  ...state,
  runtimeIdentity: identity,
  extensionUi,
  runId: null,
  terminalRunId: null,
  completionRunId: null,
  pendingPrompt: null,
  pendingOperation: null,
  ephemeralMessages: [],
  agentRunning: false,
  isStreaming: false,
  streamingMessage: null,
  activeBashExecution: null,
  retryInfo: null,
  isCompacting: false,
})

export const projectSessionMessages = (state: SessionUiState): ReadonlyArray<AgentMessage> => [
  ...state.messages,
  ...(state.pendingPrompt === null ? [] : [state.pendingPrompt.message]),
  ...state.ephemeralMessages.map(({ message }) => message),
]

export const projectSessionEntryIds = (state: SessionUiState): ReadonlyArray<string | undefined> => [
  ...state.entryIds,
  ...(state.pendingPrompt === null ? [] : [undefined]),
  ...state.ephemeralMessages.map(() => undefined),
]

const applyRuntime = (state: SessionUiState, runtime: RuntimeSnapshotValue | null): SessionUiState => {
  if (runtime === null) return state
  const identified: SessionUiState =
    state.runtimeIdentity !== null && sameRuntimeIdentity(state.runtimeIdentity, runtime.identity)
      ? runtime.extensionUi.revision > state.extensionUi.revision
        ? { ...state, extensionUi: runtime.extensionUi }
        : state
      : installRuntimeIdentity(state, runtime.identity, runtime.extensionUi)
  if (identified.pendingPrompt !== null && runtime.runId === null) {
    return { ...identified, queuedMessages: runtime.queuedMessages }
  }
  if (runtime.runId !== null && runtime.runId === identified.terminalRunId && identified.pendingPrompt !== null) {
    return identified
  }
  const expectedRunId = identified.pendingPrompt?.runId ?? identified.runId
  if (expectedRunId !== null && runtime.runId !== null && runtime.runId !== expectedRunId) return identified
  const operationKind = runtime.operation._tag === "Idle" ? null : runtime.operation.kind
  return {
    ...identified,
    runId: runtime.runId,
    pendingPrompt:
      identified.pendingPrompt === null || runtime.runId === null
        ? identified.pendingPrompt
        : { ...identified.pendingPrompt, runId: runtime.runId },
    terminalRunId:
      runtime.runId !== null && runtime.operation._tag === "Idle"
        ? runtime.runId
        : identified.terminalRunId === runtime.runId
          ? null
          : identified.terminalRunId,
    pendingOperation: null,
    agentRunning: operationKind !== null,
    isStreaming: operationKind === "prompt",
    activeBashExecution: runtime.activeBashExecution,
    queuedMessages: runtime.queuedMessages,
    isCompacting: operationKind === "compaction",
  }
}

export const sessionUiReducer = (state: SessionUiState, action: SessionUiAction): SessionUiState => {
  switch (action._tag) {
    case "Reset":
      return action.sessionId === state.sessionId ? state : { ...initialSessionUiState, sessionId: action.sessionId }
    case "LoadFailed":
      return action.sessionId === state.sessionId ? { ...state, error: action.message } : state
    case "ChromeControlRequested":
      return state.chromeControlOperation === null
        ? {
            ...state,
            chromeControlOperation: { requestId: action.requestId, enabled: action.enabled },
          }
        : state
    case "ChromeControlSucceeded":
      return state.chromeControlOperation?.requestId === action.requestId
        ? { ...state, chromeControlOperation: null }
        : state
    case "ChromeControlFailed":
      return state.chromeControlOperation?.requestId === action.requestId
        ? { ...state, chromeControlOperation: null }
        : state
    case "Loaded":
      if (
        action.sessionId !== state.sessionId ||
        action.snapshot.sessionId !== action.sessionId ||
        action.requestId < state.snapshotRequestId
      )
        return state
      const loadedReceipt = promptReceipt(state.pendingPrompt, action.snapshot.context)
      const loadedPending =
        state.pendingPrompt === null
          ? null
          : loadedReceipt === undefined
            ? state.pendingPrompt
            : loadedReceipt.userEntryId === undefined
              ? { ...state.pendingPrompt, runId: loadedReceipt.runId }
              : null
      const loadedRuntime = action.snapshot.runtime
      const expectedRunId = loadedPending?.runId ?? state.runId
      if (
        loadedRuntime !== null &&
        state.runtimeIdentity !== null &&
        sameRuntimeIdentity(state.runtimeIdentity, loadedRuntime.identity) &&
        expectedRunId !== null &&
        loadedRuntime.runId !== null &&
        loadedRuntime.runId !== expectedRunId
      ) {
        return loadedRuntime.extensionUi.revision > state.extensionUi.revision
          ? { ...state, snapshotRequestId: action.requestId, extensionUi: loadedRuntime.extensionUi }
          : { ...state, snapshotRequestId: action.requestId }
      }
      return applyRuntime(
        {
          ...state,
          snapshotRequestId: action.requestId,
          snapshot: action.snapshot,
          messages: action.snapshot.context.messages,
          entryIds: action.snapshot.context.entryIds,
          pendingPrompt: loadedPending,
          ephemeralMessages: [],
          error: null,
        },
        action.snapshot.runtime,
      )
    case "ContextRequested":
      return action.sessionId === state.sessionId ? { ...state, contextRequestId: action.requestId } : state
    case "ContextLoaded":
      if (action.sessionId !== state.sessionId || action.requestId !== state.contextRequestId) return state
      const contextReceipt = promptReceipt(state.pendingPrompt, action.context)
      return {
        ...state,
        snapshot:
          state.snapshot === null
            ? null
            : { ...state.snapshot, context: action.context, contextPage: action.page, leafId: action.leafId },
        messages: action.context.messages,
        entryIds: action.context.entryIds,
        pendingPrompt:
          state.pendingPrompt === null
            ? null
            : contextReceipt?.userEntryId !== undefined
              ? null
              : contextReceipt === undefined
                ? state.pendingPrompt
                : { ...state.pendingPrompt, runId: contextReceipt.runId },
        ephemeralMessages: [],
      }
    case "ContextPrepended": {
      if (action.sessionId !== state.sessionId || action.requestId !== state.contextRequestId) return state
      const existingIds = new Set(state.entryIds)
      const messages: Array<AgentMessage> = []
      const entryIds: Array<string> = []
      for (let index = 0; index < action.page.context.entryIds.length; index += 1) {
        const entryId = action.page.context.entryIds[index]
        const message = action.page.context.messages[index]
        if (entryId === undefined || message === undefined || existingIds.has(entryId)) continue
        entryIds.push(entryId)
        messages.push(message)
      }
      const nextMessages = [...messages, ...state.messages]
      const nextEntryIds = [...entryIds, ...state.entryIds]
      return {
        ...state,
        snapshot:
          state.snapshot === null
            ? null
            : {
                ...state.snapshot,
                context: {
                  ...action.page.context,
                  messages: nextMessages,
                  entryIds: nextEntryIds,
                },
                contextPage: {
                  beforeEntryId: action.page.beforeEntryId,
                  hasMoreBefore: action.page.hasMoreBefore,
                },
              },
        messages: nextMessages,
        entryIds: nextEntryIds,
      }
    }
    case "OperationPending":
      if (action.sessionId !== state.sessionId) return state
      return {
        ...state,
        runId: null,
        pendingOperation: action.kind,
        completionRunId: null,
        agentRunning: action.kind === "prompt" || action.kind === "bash" ? true : state.agentRunning,
        isStreaming: action.kind === "prompt" ? true : state.isStreaming,
        isCompacting: action.kind === "compaction" ? true : state.isCompacting,
        compactResult: action.kind === "compaction" ? null : state.compactResult,
        error: null,
      }
    case "OperationAccepted":
      if (action.sessionId !== state.sessionId) return state
      return {
        ...state,
        runId: action.runId,
        terminalRunId: null,
        completionRunId: null,
        pendingOperation: null,
        agentRunning: action.kind === "prompt" || action.kind === "bash" ? true : state.agentRunning,
        isStreaming: action.kind === "prompt" ? true : false,
        isCompacting: action.kind === "compaction" ? true : state.isCompacting,
        streamingMessage: action.kind === "prompt" ? null : state.streamingMessage,
        error: null,
      }
    case "PromptAccepted":
      if (action.sessionId !== state.sessionId || state.pendingPrompt?.requestId !== action.requestId) return state
      if (state.pendingPrompt.runId !== null && state.pendingPrompt.runId !== action.runId) return state
      return state.terminalRunId === action.runId
        ? {
            ...state,
            runId: action.runId,
            pendingPrompt: { ...state.pendingPrompt, runId: action.runId },
            pendingOperation: null,
          }
        : {
            ...state,
            runId: action.runId,
            terminalRunId: null,
            completionRunId: null,
            pendingPrompt: { ...state.pendingPrompt, runId: action.runId },
            pendingOperation: null,
            agentRunning: true,
            isStreaming: true,
            streamingMessage: null,
            error: null,
          }
    case "OperationFailed":
      if (action.sessionId !== state.sessionId) return state
      return {
        ...state,
        pendingOperation: state.pendingOperation === action.kind ? null : state.pendingOperation,
        agentRunning: action.kind === "prompt" || action.kind === "bash" ? false : state.agentRunning,
        isStreaming: action.kind === "prompt" ? false : state.isStreaming,
        isCompacting: action.kind === "compaction" ? false : state.isCompacting,
        pendingPrompt: action.kind === "prompt" ? null : state.pendingPrompt,
        error: action.message,
      }
    case "PromptSubmitted":
      return state.pendingPrompt === null
        ? {
            ...state,
            pendingPrompt: {
              requestId: action.requestId,
              runId: null,
              message: action.message,
            },
            runId: null,
            completionRunId: null,
            pendingOperation: "prompt",
            agentRunning: true,
            isStreaming: true,
            streamingMessage: null,
            ephemeralMessages: [],
            error: null,
          }
        : state
    case "RuntimeEvent": {
      if (action.sessionId !== state.sessionId) return state
      const event = action.event
      const currentIdentity = state.runtimeIdentity
      if (currentIdentity === null) {
        return event._tag === "RuntimeActivated"
          ? installRuntimeIdentity(state, action.identity, event.projection)
          : state
      }
      if (action.identity.registryId !== currentIdentity.registryId) return state
      if (action.identity.runtimeEpoch < currentIdentity.runtimeEpoch) return state
      if (action.identity.runtimeEpoch > currentIdentity.runtimeEpoch) {
        return event._tag === "RuntimeActivated"
          ? installRuntimeIdentity(state, action.identity, event.projection)
          : state
      }
      if (!sameRuntimeIdentity(action.identity, currentIdentity)) return state
      if (event._tag === "RuntimeActivated") {
        return event.projection.revision > state.extensionUi.revision
          ? { ...state, extensionUi: event.projection }
          : state
      }
      if (event._tag === "ExtensionUiChanged") {
        return event.projection.revision > state.extensionUi.revision
          ? { ...state, extensionUi: event.projection }
          : state
      }
      if (event._tag === "ExtensionNotice" || event._tag === "ExtensionFailed") return state
      if (state.terminalRunId === event.runId) return state
      const expectedRunId = activeRunId(state)
      if (expectedRunId !== null && event.runId !== expectedRunId) return state
      switch (event._tag) {
        case "RunStarted":
          return {
            ...state,
            runId: event.runId,
            pendingPrompt: state.pendingPrompt === null ? null : { ...state.pendingPrompt, runId: event.runId },
            pendingOperation: null,
            agentRunning: true,
            isStreaming: true,
          }
        case "RunFinished":
          if (!state.agentRunning && !state.isStreaming) return state
          return {
            ...state,
            runId: event.runId,
            terminalRunId: event.runId,
            completionRunId: event.runId,
            pendingOperation: null,
            agentRunning: state.activeBashExecution !== null,
            isStreaming: false,
            streamingMessage: null,
            retryInfo: null,
          }
        case "RunFailed":
          return {
            ...state,
            runId: event.runId,
            terminalRunId: event.runId,
            completionRunId: null,
            pendingOperation: null,
            agentRunning: false,
            isStreaming: false,
            streamingMessage: null,
            error: event.message,
          }
        case "MessageStarted":
        case "MessageUpdated":
          return event.message.role === "assistant"
            ? { ...state, streamingMessage: event.message, isStreaming: true }
            : state
        case "MessageFinished":
          if (event.message.role === "user" && state.pendingPrompt !== null) return state
          const ephemeralMessages = appendEphemeral(state.ephemeralMessages, event.eventId, event.runId, event.message)
          if (ephemeralMessages === state.ephemeralMessages && event.message.role !== "assistant") return state
          if (ephemeralMessages === state.ephemeralMessages && state.streamingMessage === null) return state
          return {
            ...state,
            ephemeralMessages,
            streamingMessage: event.message.role === "assistant" ? null : state.streamingMessage,
          }
        case "ToolStarted":
        case "ToolFinished":
          return state
        case "QueueChanged":
          return { ...state, queuedMessages: event.queued }
        case "RetryStarted":
          return {
            ...state,
            retryInfo: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
            },
          }
        case "RetryFinished":
          return { ...state, retryInfo: null }
        case "CompactionStarted":
          return { ...state, runId: event.runId, pendingOperation: null, isCompacting: true, compactResult: null }
        case "CompactionFinished":
          return {
            ...state,
            terminalRunId: event.runId,
            pendingOperation: null,
            isCompacting: false,
            compactResult:
              event.tokensBefore === undefined || event.estimatedTokensAfter === undefined
                ? null
                : {
                    reason: event.reason ?? "manual",
                    tokensBefore: event.tokensBefore,
                    estimatedTokensAfter: event.estimatedTokensAfter,
                  },
            ...(event.errorMessage === undefined ? {} : { error: event.errorMessage }),
          }
        case "BashStarted":
          return {
            ...state,
            runId: event.runId,
            pendingOperation: null,
            agentRunning: true,
            activeBashExecution: event.execution,
          }
        case "BashOutput":
          return state.activeBashExecution?.id === event.id
            ? {
                ...state,
                activeBashExecution: {
                  ...state.activeBashExecution,
                  output: `${state.activeBashExecution.output}${event.chunk}`,
                },
              }
            : state
        case "BashFinished":
          return {
            ...state,
            terminalRunId: event.runId,
            pendingOperation: null,
            agentRunning: state.isStreaming,
            activeBashExecution: null,
            ephemeralMessages: appendEphemeral(
              state.ephemeralMessages,
              `bash:${event.execution.id}`,
              event.runId,
              event.execution.message,
            ),
          }
        case "BashFailed":
          return {
            ...state,
            terminalRunId: event.runId,
            pendingOperation: null,
            agentRunning: false,
            activeBashExecution: null,
            error: event.message,
          }
      }
    }
  }
}
