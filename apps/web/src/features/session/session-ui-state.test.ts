import { expect, test } from "vite-plus/test"
import { RegistryId, RunId, RuntimeId, RuntimeIdentity, RuntimeSnapshot, SessionSnapshot } from "@/api/contract"
import {
  initialSessionUiState,
  projectSessionEntryIds,
  projectSessionMessages,
  sessionUiReducer,
} from "./session-ui-state"

const runtimeIdentity = (runtimeId = "runtime-1", runtimeEpoch = 1, registryId = "registry-1") =>
  RuntimeIdentity.make({
    registryId: RegistryId.make(registryId),
    runtimeEpoch,
    runtimeId: RuntimeId.make(runtimeId),
  })

const identity = runtimeIdentity()

const runtime = (runId: string | null, streaming: boolean, runtimeIdentityValue = identity) =>
  RuntimeSnapshot.make({
    identity: runtimeIdentityValue,
    runId: runId === null ? null : RunId.make(runId),
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    isStreaming: streaming,
    isPromptRunning: streaming,
    isCompacting: false,
    isBashRunning: false,
    activeBashExecution: null,
    completedBashExecution: null,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    pendingMessageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    contextUsage: null,
    systemPrompt: "",
    thinkingLevel: "high",
    extensionUi: {
      revision: 0,
      pendingInteraction: null,
      statuses: [],
      widgets: [],
    },
  })

const sessionState = () => ({
  ...sessionUiReducer(initialSessionUiState, {
    _tag: "Reset",
    sessionId: "session-1",
  }),
  runtimeIdentity: identity,
})

test("accepts events only for the current opaque run id", () => {
  const accepted = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("current-run"),
  })
  const stale = sessionUiReducer(accepted, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("old-run") },
  })
  expect(stale).toBe(accepted)

  const finished = sessionUiReducer(accepted, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("current-run") },
  })
  expect(finished.isStreaming).toBe(false)
  expect(finished.agentRunning).toBe(false)
  expect(finished.terminalRunId).toBe("current-run")
  expect(finished.completionRunId).toBe("current-run")

  const duplicate = sessionUiReducer(finished, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("current-run") },
  })
  expect(duplicate).toBe(finished)
})

test("installs the first live runtime identity from RuntimeActivated", () => {
  const browsing = sessionUiReducer(initialSessionUiState, { _tag: "Reset", sessionId: "session-1" })
  const started = sessionUiReducer(browsing, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "RuntimeActivated",
      projection: runtime(null, false).extensionUi,
    },
  })
  expect(started.runtimeIdentity).toEqual(identity)

  const stale = sessionUiReducer(started, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity: runtimeIdentity("runtime-old"),
    event: { _tag: "ExtensionUiChanged", projection: { ...started.extensionUi, revision: 1 } },
  })
  expect(stale).toBe(started)
})

test("adopts only an activated successor and rejects predecessor replay", () => {
  const successor = runtimeIdentity("runtime-2", 2)
  const base = sessionState()
  const premature = sessionUiReducer(base, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity: successor,
    event: { _tag: "RunStarted", runId: RunId.make("successor-run") },
  })
  expect(premature).toBe(base)

  const activated = sessionUiReducer(base, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity: successor,
    event: { _tag: "RuntimeActivated", projection: { ...base.extensionUi, revision: 0 } },
  })
  expect(activated.runtimeIdentity).toEqual(successor)

  const predecessorReplay = sessionUiReducer(activated, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "ExtensionUiChanged", projection: { ...base.extensionUi, revision: 99 } },
  })
  expect(predecessorReplay).toBe(activated)
})

test("changes registry identity only through an authoritative snapshot", () => {
  const restarted = runtimeIdentity("runtime-restarted", 1, "registry-2")
  const base = sessionState()
  const ignored = sessionUiReducer(base, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity: restarted,
    event: { _tag: "RuntimeActivated", projection: { ...base.extensionUi, revision: 3 } },
  })
  expect(ignored).toBe(base)

  const snapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: null,
    tree: [],
    context: { messages: [], entryIds: [], promptRequests: [], thinkingLevel: "high", model: null },
    runtime: runtime(null, false, restarted),
  })
  const adopted = sessionUiReducer(base, {
    _tag: "Loaded",
    sessionId: "session-1",
    requestId: 1,
    snapshot,
  })
  expect(adopted.runtimeIdentity).toEqual(restarted)
})

test("adopts an external run while idle and projects its messages in real time", () => {
  const previous = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("web-run"),
  })
  const idle = sessionUiReducer(previous, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("web-run") },
  })
  const started = sessionUiReducer(idle, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunStarted", runId: RunId.make("weixin-run") },
  })
  const foreign = sessionUiReducer(started, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "MessageFinished",
      eventId: "foreign-user",
      runId: RunId.make("foreign-run"),
      message: { role: "user", content: "不属于当前 run" },
    },
  })
  const withUser = sessionUiReducer(foreign, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "MessageFinished",
      eventId: "weixin-user",
      runId: RunId.make("weixin-run"),
      message: { role: "user", content: "微信语音转写" },
    },
  })
  const withAssistant = sessionUiReducer(withUser, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "MessageFinished",
      eventId: "weixin-assistant",
      runId: RunId.make("weixin-run"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "微信回复" }],
        provider: "test-provider",
        model: "test-model",
      },
    },
  })
  const finished = sessionUiReducer(withAssistant, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("weixin-run") },
  })

  expect(started.runId).toBe("weixin-run")
  expect(foreign).toBe(started)
  expect(projectSessionMessages(finished)).toEqual([
    { role: "user", content: "微信语音转写" },
    {
      role: "assistant",
      content: [{ type: "text", text: "微信回复" }],
      provider: "test-provider",
      model: "test-model",
    },
  ])
  expect(finished.terminalRunId).toBe("weixin-run")
  expect(finished.completionRunId).toBe("weixin-run")
  expect(finished.agentRunning).toBe(false)
  expect(finished.isStreaming).toBe(false)
})

test("replayed lifecycle events cannot complete a run restored as terminal", () => {
  const snapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: null,
    tree: [],
    context: { messages: [], entryIds: [], promptRequests: [], thinkingLevel: "high", model: null },
    runtime: runtime("completed-run", false),
  })
  const restored = sessionUiReducer(sessionState(), {
    _tag: "Loaded",
    requestId: 1,
    sessionId: "session-1",
    snapshot,
  })
  expect(restored.terminalRunId).toBe("completed-run")
  expect(restored.completionRunId).toBeNull()

  const replayedStart = sessionUiReducer(restored, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunStarted", runId: RunId.make("completed-run") },
  })
  const replayedFinish = sessionUiReducer(replayedStart, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("completed-run") },
  })
  expect(replayedStart).toBe(restored)
  expect(replayedFinish).toBe(restored)
  expect(replayedFinish.completionRunId).toBeNull()
})

test("reconciliation cannot replace a newer run with an older snapshot", () => {
  const withMessage = sessionUiReducer(sessionState(), {
    _tag: "PromptSubmitted",
    requestId: "request-1",
    message: { role: "user", content: "current prompt" },
  })
  const current = sessionUiReducer(withMessage, {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("new-run"),
  })
  const snapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: null,
    tree: [],
    context: { messages: [], entryIds: [], promptRequests: [], thinkingLevel: "high", model: null },
    runtime: runtime("old-run", true),
  })
  const reconciled = sessionUiReducer(current, { _tag: "Loaded", sessionId: "session-1", requestId: 1, snapshot })
  expect(reconciled.snapshotRequestId).toBe(1)
  expect(reconciled.runId).toBe("new-run")
  expect(reconciled.isStreaming).toBe(true)
  expect(projectSessionMessages(reconciled)).toEqual([{ role: "user", content: "current prompt" }])
})

test("hydrates streaming state from the authoritative session snapshot", () => {
  const snapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: null,
    tree: [],
    context: {
      messages: [{ role: "user", content: "hello" }],
      entryIds: ["entry-1"],
      promptRequests: [],
      thinkingLevel: "high",
      model: null,
    },
    runtime: runtime("active-run", true),
  })
  const state = sessionUiReducer(sessionState(), { _tag: "Loaded", sessionId: "session-1", requestId: 1, snapshot })
  expect(state.runId).toBe("active-run")
  expect(state.isStreaming).toBe(true)
  expect(state.agentRunning).toBe(true)
  expect(state.entryIds).toEqual(["entry-1"])
})

test("keeps optimistic messages idempotent", () => {
  const action = {
    _tag: "PromptSubmitted" as const,
    requestId: "request-1",
    message: { role: "user" as const, content: "hello" },
  }
  const once = sessionUiReducer(sessionState(), action)
  const twice = sessionUiReducer(once, action)
  expect(twice.messages).toEqual([])
  expect(projectSessionMessages(twice)).toEqual([{ role: "user", content: "hello" }])
})

test("owns Chrome control pending state by projection and request receipt", () => {
  const active = sessionState()
  const pending = sessionUiReducer(active, {
    _tag: "ChromeControlRequested",
    requestId: "chrome-1",
    enabled: true,
  })
  expect(pending.chromeControlOperation).toEqual({ requestId: "chrome-1", enabled: true })
  expect(sessionUiReducer(pending, { _tag: "ChromeControlFailed", requestId: "chrome-stale" })).toBe(pending)

  const succeeded = sessionUiReducer(pending, {
    _tag: "ChromeControlSucceeded",
    requestId: "chrome-1",
  })
  expect(succeeded.chromeControlOperation).toBeNull()

  const nextPending = sessionUiReducer(succeeded, {
    _tag: "ChromeControlRequested",
    requestId: "chrome-2",
    enabled: false,
  })
  const switched = sessionUiReducer(nextPending, { _tag: "Reset", sessionId: "session-other" })
  expect(switched.chromeControlOperation).toBeNull()
})

test("only a new authoritative entry confirms a submitted prompt", () => {
  const originalSnapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: "entry-old",
    tree: [],
    context: {
      messages: [{ role: "user", content: "hello" }],
      entryIds: ["entry-old"],
      promptRequests: [],
      thinkingLevel: "high",
      model: null,
    },
    runtime: runtime(null, false),
  })
  const loaded = sessionUiReducer(sessionState(), {
    _tag: "Loaded",
    requestId: 1,
    sessionId: "session-1",
    snapshot: originalSnapshot,
  })
  const submitted = sessionUiReducer(loaded, {
    _tag: "PromptSubmitted",
    requestId: "request-1",
    message: { role: "user", content: "hello" },
  })
  const unchanged = sessionUiReducer(submitted, {
    _tag: "Loaded",
    requestId: 2,
    sessionId: "session-1",
    snapshot: originalSnapshot,
  })
  expect(projectSessionMessages(unchanged)).toHaveLength(2)

  const confirmedSnapshot = SessionSnapshot.make({
    ...originalSnapshot,
    leafId: "entry-new",
    context: {
      ...originalSnapshot.context,
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: "hello" },
      ],
      entryIds: ["entry-old", "entry-new"],
      promptRequests: [{ requestId: "request-1", runId: RunId.make("run-1"), userEntryId: "entry-new" }],
    },
  })
  const confirmed = sessionUiReducer(unchanged, {
    _tag: "Loaded",
    requestId: 3,
    sessionId: "session-1",
    snapshot: confirmedSnapshot,
  })
  expect(confirmed.pendingPrompt).toBeNull()
  expect(projectSessionMessages(confirmed)).toEqual(confirmedSnapshot.context.messages)
})

test("confirms a prompt by request identity across Pi content representations", () => {
  const submitted = sessionUiReducer(sessionState(), {
    _tag: "PromptSubmitted",
    requestId: "request-text-block",
    message: { role: "user", content: "什么模型" },
  })
  const snapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: "assistant-entry",
    tree: [],
    context: {
      messages: [
        { role: "user", content: [{ type: "text", text: "什么模型" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          model: "test-model",
          provider: "test-provider",
        },
      ],
      entryIds: ["user-entry", "assistant-entry"],
      promptRequests: [
        {
          requestId: "request-text-block",
          runId: RunId.make("run-text-block"),
          userEntryId: "user-entry",
          assistantEntryId: "assistant-entry",
        },
      ],
      thinkingLevel: "high",
      model: null,
    },
    runtime: runtime("run-text-block", false),
  })
  const reconciled = sessionUiReducer(submitted, {
    _tag: "Loaded",
    sessionId: "session-1",
    requestId: 1,
    snapshot,
  })

  expect(projectSessionMessages(reconciled)).toEqual(snapshot.context.messages)
  expect(projectSessionMessages(reconciled).filter((message) => message.role === "user")).toHaveLength(1)
  expect(projectSessionEntryIds(reconciled)).toEqual(["user-entry", "assistant-entry"])
})

test("distinguishes consecutive identical prompts by request id", () => {
  const first = sessionUiReducer(sessionState(), {
    _tag: "PromptSubmitted",
    requestId: "request-1",
    message: { role: "user", content: "repeat" },
  })
  const firstSnapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: "entry-1",
    tree: [],
    context: {
      messages: [{ role: "user", content: [{ type: "text", text: "repeat" }] }],
      entryIds: ["entry-1"],
      promptRequests: [{ requestId: "request-1", runId: RunId.make("run-1"), userEntryId: "entry-1" }],
      thinkingLevel: "high",
      model: null,
    },
    runtime: null,
  })
  const firstPersisted = sessionUiReducer(first, {
    _tag: "Loaded",
    sessionId: "session-1",
    requestId: 1,
    snapshot: firstSnapshot,
  })
  const second = sessionUiReducer(firstPersisted, {
    _tag: "PromptSubmitted",
    requestId: "request-2",
    message: { role: "user", content: "repeat" },
  })

  expect(projectSessionMessages(second)).toHaveLength(2)
  expect(projectSessionEntryIds(second)).toEqual(["entry-1", undefined])
})

test("binds RunStarted that arrives before prompt acceptance and rejects the old run", () => {
  const previous = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("old-run"),
  })
  const finished = sessionUiReducer(previous, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("old-run") },
  })
  const submitted = sessionUiReducer(finished, {
    _tag: "PromptSubmitted",
    requestId: "request-new",
    message: { role: "user", content: "new" },
  })
  const stale = sessionUiReducer(submitted, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunStarted", runId: RunId.make("old-run") },
  })
  const started = sessionUiReducer(stale, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunStarted", runId: RunId.make("new-run") },
  })
  const accepted = sessionUiReducer(started, {
    _tag: "PromptAccepted",
    sessionId: "session-1",
    requestId: "request-new",
    runId: RunId.make("new-run"),
  })

  expect(stale).toBe(submitted)
  expect(started.pendingPrompt?.runId).toBe("new-run")
  expect(accepted.runId).toBe("new-run")
  expect(accepted.isStreaming).toBe(true)
})

test("keeps ephemeral SSE messages outside persisted message-entry pairs", () => {
  const started = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("run-1"),
  })
  const eventState = sessionUiReducer(started, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "MessageFinished",
      eventId: "event-1",
      runId: RunId.make("run-1"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "test-model",
        provider: "test-provider",
      },
    },
  })

  expect(eventState.messages).toEqual([])
  expect(eventState.entryIds).toEqual([])
  expect(projectSessionMessages(eventState)).toHaveLength(1)
  expect(projectSessionEntryIds(eventState)).toEqual([undefined])
  expect(
    sessionUiReducer(eventState, {
      _tag: "RuntimeEvent",
      sessionId: "session-1",
      identity,
      event: {
        _tag: "MessageFinished",
        eventId: "event-1",
        runId: RunId.make("run-1"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "test-model",
          provider: "test-provider",
        },
      },
    }),
  ).toBe(eventState)
})

test("does not promote a recoverable extension failure to the session fatal error", () => {
  const running = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("run-1"),
  })
  const afterFailure = sessionUiReducer(running, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "ExtensionFailed",
      message: "Extension operation failed",
    },
  })

  expect(afterFailure).toBe(running)
  expect(afterFailure.error).toBeNull()
  expect(afterFailure.agentRunning).toBe(true)
})

test("rejects snapshot and events from a previous session epoch", () => {
  const state = sessionUiReducer(initialSessionUiState, { _tag: "Reset", sessionId: "session-2" })
  const staleSnapshot = SessionSnapshot.make({
    sessionId: "session-1",
    filePath: "/sessions/session-1.jsonl",
    info: null,
    leafId: null,
    tree: [],
    context: {
      messages: [{ role: "user", content: "stale" }],
      entryIds: ["old"],
      promptRequests: [],
      thinkingLevel: "high",
      model: null,
    },
    runtime: runtime("old-run", true),
  })
  const afterSnapshot = sessionUiReducer(state, {
    _tag: "Loaded",
    requestId: 1,
    sessionId: "session-1",
    snapshot: staleSnapshot,
  })
  const afterEvent = sessionUiReducer(afterSnapshot, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunStarted", runId: RunId.make("old-run") },
  })
  expect(afterSnapshot).toBe(state)
  expect(afterEvent).toBe(state)
})

test("accepts only the latest branch context request", () => {
  const base = sessionState()
  const first = sessionUiReducer(base, { _tag: "ContextRequested", sessionId: "session-1", requestId: 1 })
  const second = sessionUiReducer(first, { _tag: "ContextRequested", sessionId: "session-1", requestId: 2 })
  const stale = sessionUiReducer(second, {
    _tag: "ContextLoaded",
    sessionId: "session-1",
    requestId: 1,
    leafId: "leaf-1",
    context: {
      messages: [{ role: "user", content: "old" }],
      entryIds: ["leaf-1"],
      promptRequests: [],
      thinkingLevel: "high",
      model: null,
    },
  })
  expect(stale).toBe(second)
})

test("binds a new bash operation after an older run has finished", () => {
  const acceptedPrompt = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "prompt",
    runId: RunId.make("prompt-run"),
  })
  const finished = sessionUiReducer(acceptedPrompt, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "RunFinished", runId: RunId.make("prompt-run") },
  })
  const bash = sessionUiReducer(finished, {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "bash",
    runId: RunId.make("bash-run"),
  })
  const started = sessionUiReducer(bash, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "BashStarted",
      runId: RunId.make("bash-run"),
      execution: { id: "bash-1", command: "sleep 30", output: "", excludeFromContext: false, startedAt: 1 },
    },
  })
  expect(started.activeBashExecution?.id).toBe("bash-1")
  expect(started.isStreaming).toBe(false)
  expect(started.agentRunning).toBe(true)
})

test("binds a bash event that arrives before its mutation response", () => {
  const priorAccepted = sessionUiReducer(sessionState(), {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "bash",
    runId: RunId.make("prior-run"),
  })
  const priorStarted = sessionUiReducer(priorAccepted, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "BashStarted",
      runId: RunId.make("prior-run"),
      execution: { id: "prior", command: "true", output: "", excludeFromContext: false, startedAt: 1 },
    },
  })
  const priorFinished = sessionUiReducer(priorStarted, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "BashFinished",
      runId: RunId.make("prior-run"),
      execution: {
        id: "prior",
        message: {
          role: "bashExecution",
          command: "true",
          output: "",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 2,
          excludeFromContext: false,
        },
      },
    },
  })
  const pending = sessionUiReducer(priorFinished, {
    _tag: "OperationPending",
    sessionId: "session-1",
    kind: "bash",
  })
  expect(pending.runId).toBeNull()
  expect(pending.terminalRunId).toBe("prior-run")
  const started = sessionUiReducer(pending, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "BashStarted",
      runId: RunId.make("next-run"),
      execution: { id: "next", command: "sleep 30", output: "", excludeFromContext: false, startedAt: 3 },
    },
  })
  expect(started.runId).toBe("next-run")
  const accepted = sessionUiReducer(started, {
    _tag: "OperationAccepted",
    sessionId: "session-1",
    kind: "bash",
    runId: RunId.make("next-run"),
  })
  expect(accepted.activeBashExecution?.id).toBe("next")
  expect(accepted.agentRunning).toBe(true)
})

test("projects extension interaction without a run and rejects stale projection replay", () => {
  const idle = sessionState()
  expect(idle.runId).toBeNull()
  const projection = {
    revision: 2,
    pendingInteraction: {
      interactionId: "weixin-code",
      method: "input" as const,
      title: "输入手机微信显示的配对码",
      placeholder: "配对码",
    },
    statuses: [],
    widgets: [],
  }
  const projected = sessionUiReducer(idle, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: { _tag: "ExtensionUiChanged", projection },
  })
  expect(projected.extensionUi).toEqual(projection)
  expect(projected.runId).toBeNull()

  const stale = sessionUiReducer(projected, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity,
    event: {
      _tag: "ExtensionUiChanged",
      projection: { ...projection, revision: 1, pendingInteraction: null },
    },
  })
  expect(stale).toBe(projected)

  const wrongRuntime = sessionUiReducer(projected, {
    _tag: "RuntimeEvent",
    sessionId: "session-1",
    identity: runtimeIdentity("runtime-old"),
    event: {
      _tag: "ExtensionUiChanged",
      projection: { ...projection, revision: 3, pendingInteraction: null },
    },
  })
  expect(wrongRuntime).toBe(projected)
})
