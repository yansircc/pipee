import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Effect } from "effect"
import type { Cancel } from "@/browser/api-client"
import { useBrowserEffectScope } from "@/browser/use-browser-effect-scope"
import { loadSessionSnapshot, observeSession, sessionController } from "@/features/session/session-controller"
import {
  initialSessionUiState,
  projectSessionMessages,
  projectTranscriptSources,
  sessionUiReducer,
} from "@/features/session/session-ui-state"
import { parseBashCommand } from "@/lib/bash-command"
import { copyText } from "@/lib/clipboard"
import { DEFAULT_TOOL_PRESET, getPresetFromTools, getToolNamesForPreset, type ToolPreset } from "@/lib/tool-presets"
import { useToast } from "@/ui/feedback/Toast"
import type {
  ActiveBashExecution,
  AgentMessage,
  ExtensionInteraction,
  SessionBranchNode,
  SessionInfo,
  SessionStats as SessionStatsInfo,
  UserMessage,
} from "@/api/contract"

export interface SessionData {
  sessionId: string
  filePath: string
  branchNodes: SessionBranchNode[]
  leafId: string | null
  context: {
    messages: AgentMessage[]
    entryIds: string[]
    thinkingLevel: string
    model: { provider: string; modelId: string } | null
  }
}

export interface QueuedMessages {
  steering: string[]
  followUp: string[]
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null

export interface CompactResultInfo {
  reason: string
  tokensBefore: number
  estimatedTokensAfter: number
}

export interface SlashCommandInfo {
  name: string
  description?: string
  source: "extension" | "prompt" | "skill"
  sourceInfo?: {
    path: string
    source: string
    scope: "user" | "project" | "temporary"
    origin: "package" | "top-level"
    baseDir?: string
  }
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" }

export interface ChatInputHandle {
  insertText: (text: string) => void
  insertIfEmpty: (content: string) => void
  prependText: (text: string) => void
  addImages: (files: File[]) => void
}

export interface UseAgentSessionOptions {
  session: SessionInfo
  sessionRefreshKey: number
  onAgentEnd?: () => void
  onSessionIndexChanged?: () => void
  onSessionForked?: (newSessionId: string) => void
  modelsRefreshKey?: number
  chatInputRef?: React.RefObject<ChatInputHandle | null>
  onBranchDataChange?: (
    branchNodes: SessionBranchNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => void
  onSystemPromptChange?: (prompt: string | null) => void
  onSessionStatsPanelOpen?: () => void
  setToolPreset?: (preset: ToolPreset) => void
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export interface AttachedImage {
  data: string
  mimeType: string
  previewUrl: string
}

type ModelEntry = { id: string; name: string; provider: string }
type ExtensionDialog = ExtensionInteraction

const messageFor = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

const cloneBranchNodes = (nodes: ReadonlyArray<SessionBranchNode>): SessionBranchNode[] =>
  nodes.map((node) => ({ ...node }))

const asUiMessages = (messages: ReadonlyArray<unknown>): AgentMessage[] =>
  messages.map((message) => message as AgentMessage)

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session,
    sessionRefreshKey,
    onAgentEnd,
    onSessionIndexChanged,
    onSessionForked,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionStatsPanelOpen,
    setToolPreset: onToolPresetChange,
    chatInputRef,
  } = opts
  const [state, dispatch] = useReducer(sessionUiReducer, initialSessionUiState)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [modelNames, setModelNames] = useState<Record<string, string>>({})
  const [modelList, setModelList] = useState<ModelEntry[]>([])
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({})
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>(
    {},
  )
  const [toolPreset, setToolPreset] = useState<ToolPreset>(DEFAULT_TOOL_PRESET)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto")
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null)
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([])
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false)
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null)
  const effectScopeOwner = `session:${session.id}`
  const runScoped = useBrowserEffectScope(effectScopeOwner)
  const { push: addNotice } = useToast()

  const sessionIdRef = useRef(session.id)
  const observerRef = useRef<Cancel | null>(null)
  const bashSequenceRef = useRef(0)
  const contextSequenceRef = useRef(0)
  const snapshotSequenceRef = useRef(0)
  const handledCompletionRunIdRef = useRef<string | null>(null)

  const loadSnapshot = useCallback(
    (sessionId: string, showLoading = false) => {
      if (showLoading) setLoading(true)
      snapshotSequenceRef.current += 1
      const requestId = snapshotSequenceRef.current
      return runScoped(loadSessionSnapshot(sessionId), {
        onSuccess: (snapshot) => {
          dispatch({ _tag: "Loaded", sessionId, requestId, snapshot })
          setThinkingLevel(
            (snapshot.runtime?.thinkingLevel as ThinkingLevelOption | undefined) ??
              (snapshot.context.thinkingLevel as ThinkingLevelOption),
          )
          setLoading(false)
        },
        onFailure: (error) => {
          dispatch({ _tag: "LoadFailed", sessionId, message: messageFor(error) })
          setLoading(false)
        },
      })
    },
    [runScoped],
  )

  const beginObserver = useCallback(
    (sessionId: string) => {
      observerRef.current?.()
      observerRef.current = runScoped(
        observeSession(sessionId, {
          onSnapshotStarted: () => {
            snapshotSequenceRef.current += 1
            return snapshotSequenceRef.current
          },
          onEvent: (envelope) => {
            const event = envelope.event
            if (event._tag === "ExtensionFailed") {
              addNotice({ type: "warning", message: event.message, source: "extension" })
            }
            if (event._tag === "ExtensionNotice") {
              addNotice({
                id: event.noticeId,
                type: event.notifyType,
                message: event.message,
                source: "extension",
              })
            }
            dispatch({ _tag: "RuntimeEvent", sessionId, identity: envelope.identity, event })
          },
          onSnapshot: (snapshot, requestId) => {
            dispatch({ _tag: "Loaded", sessionId, requestId, snapshot })
            setThinkingLevel(
              (snapshot.runtime?.thinkingLevel as ThinkingLevelOption | undefined) ??
                (snapshot.context.thinkingLevel as ThinkingLevelOption),
            )
            setLoading(false)
          },
          onTransientError: () => undefined,
        }),
        {
          onSuccess: () => undefined,
          onFailure: (error) => {
            dispatch({ _tag: "LoadFailed", sessionId, message: messageFor(error) })
            setLoading(false)
          },
        },
      )
    },
    [addNotice, runScoped],
  )

  useEffect(() => {
    const completionRunId = state.completionRunId
    const sessionId = state.sessionId
    if (completionRunId === null || sessionId === null || handledCompletionRunIdRef.current === completionRunId) return
    handledCompletionRunIdRef.current = completionRunId
    onAgentEnd?.()
    loadSnapshot(sessionId)
  }, [loadSnapshot, onAgentEnd, state.completionRunId, state.sessionId])

  const withSession = useCallback((run: (sessionId: string) => void) => run(sessionIdRef.current), [])

  const activeSessionId = session.id
  useEffect(() => {
    dispatch({ _tag: "Reset", sessionId: activeSessionId })
    observerRef.current?.()
    observerRef.current = null
    sessionIdRef.current = activeSessionId
    setLoading(true)
    beginObserver(activeSessionId)
    return () => {
      observerRef.current?.()
      observerRef.current = null
    }
  }, [activeSessionId, beginObserver])

  const modelCwd = session.cwd
  useEffect(() => {
    return runScoped(sessionController.modelCatalog(modelCwd), {
      onSuccess: (catalog) => {
        setModelNames({ ...catalog.models })
        setModelList(catalog.modelList.map((model) => ({ ...model })))
        setModelThinkingLevels(
          Object.fromEntries(Object.entries(catalog.thinkingLevels).map(([key, values]) => [key, [...values]])),
        )
        setModelThinkingLevelMaps(
          Object.fromEntries(Object.entries(catalog.thinkingLevelMaps).map(([key, value]) => [key, { ...value }])),
        )
      },
    })
  }, [modelCwd, opts.modelsRefreshKey, runScoped, sessionRefreshKey])

  const snapshot = state.snapshot
  useEffect(() => {
    setSessionStatsOverride(null)
    if (snapshot?.contextPage.hasMoreBefore !== true) return
    return runScoped(sessionController.stats(session.id), {
      onSuccess: setSessionStatsOverride,
      onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
    })
  }, [addNotice, runScoped, session.id, snapshot?.contextPage.hasMoreBefore, snapshot?.leafId])

  const data = useMemo<SessionData | null>(
    () =>
      snapshot === null
        ? null
        : {
            sessionId: snapshot.sessionId,
            filePath: snapshot.filePath,
            branchNodes: cloneBranchNodes(snapshot.branchNodes as ReadonlyArray<SessionBranchNode>),
            leafId: snapshot.leafId,
            context: {
              messages: asUiMessages(snapshot.context.messages),
              entryIds: [...snapshot.context.entryIds],
              thinkingLevel: snapshot.context.thinkingLevel,
              model: snapshot.context.model,
            },
          },
    [snapshot],
  )

  const activeLeafId = snapshot?.leafId ?? null
  const messages = useMemo(() => asUiMessages(projectSessionMessages(state)), [state])
  const transcriptSources = useMemo(() => projectTranscriptSources(state), [state])
  const extensionStatuses = state.extensionUi.statuses
  const extensionWidgets = state.extensionUi.widgets
  const activeBashExecution = state.activeBashExecution as ActiveBashExecution | null
  const currentModel = snapshot?.context.model ?? null
  const displayModel = currentModel

  const sessionStats = useMemo<SessionStatsInfo | null>(() => {
    if (sessionStatsOverride !== null) return sessionStatsOverride
    if (messages.length === 0) return null
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    let userMessages = 0
    let assistantMessages = 0
    let toolCalls = 0
    let toolResults = 0
    let cost = 0
    for (const message of messages) {
      if (message.role === "user") userMessages += 1
      if (message.role === "toolResult") toolResults += 1
      if (message.role !== "assistant") continue
      assistantMessages += 1
      toolCalls += message.content.filter((block) => block.type === "toolCall").length
      if (message.usage === undefined) continue
      tokens.input += message.usage.input
      tokens.output += message.usage.output
      tokens.cacheRead += message.usage.cacheRead
      tokens.cacheWrite += message.usage.cacheWrite
      cost += message.usage.cost.total
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    return {
      sessionFile: data?.filePath,
      sessionId: sessionIdRef.current ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(snapshot?.runtime?.contextUsage === null || snapshot?.runtime?.contextUsage === undefined
        ? {}
        : { contextUsage: snapshot.runtime.contextUsage }),
    }
  }, [data?.filePath, messages, session?.name, sessionStatsOverride, snapshot?.runtime?.contextUsage])

  const handleSend = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if ((!message.trim() && !images?.length) || state.agentRunning) return
      const uiMessage: UserMessage = images?.length
        ? {
            role: "user",
            content: [
              ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
              ...images.map((image) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
              })),
            ],
          }
        : { role: "user", content: message }
      const payloadImages = images?.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      }))
      runScoped(sessionController.nextPromptRequestId, {
        onSuccess: (requestId) => {
          dispatch({ _tag: "PromptSubmitted", requestId, message: uiMessage })
          withSession((sessionId) => {
            runScoped(sessionController.prompt(sessionId, requestId, message, payloadImages), {
              onSuccess: (accepted) => {
                dispatch({
                  _tag: "PromptAccepted",
                  sessionId,
                  requestId: accepted.requestId,
                  runId: accepted.runId,
                })
                onSessionIndexChanged?.()
              },
              onFailure: (error) =>
                dispatch({ _tag: "OperationFailed", sessionId, kind: "prompt", message: messageFor(error) }),
            })
          })
        },
        onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
      })
    },
    [addNotice, onSessionIndexChanged, runScoped, state.agentRunning, withSession],
  )

  const handleBashCommand = useCallback(
    (input: string): boolean => {
      const parsed = parseBashCommand(input)
      if (parsed === null || state.agentRunning || activeBashExecution !== null) return false
      bashSequenceRef.current += 1
      const id = `bash-${bashSequenceRef.current}`
      const pendingSessionId = sessionIdRef.current
      dispatch({ _tag: "OperationPending", sessionId: pendingSessionId, kind: "bash" })
      withSession((sessionId) => {
        runScoped(sessionController.bash(sessionId, id, parsed.command, parsed.excludeFromContext), {
          onSuccess: ({ runId }) => {
            dispatch({ _tag: "OperationAccepted", sessionId, kind: "bash", runId })
          },
          onFailure: (error) => {
            dispatch({ _tag: "OperationFailed", sessionId, kind: "bash", message: messageFor(error) })
            addNotice({ type: "error", message: messageFor(error) })
          },
        })
      })
      return true
    },
    [activeBashExecution, addNotice, runScoped, state.agentRunning, withSession],
  )

  const handleAbort = useCallback(() => {
    const sessionId = sessionIdRef.current
    if (sessionId === null) return
    runScoped(
      activeBashExecution === null && state.pendingOperation !== "bash"
        ? sessionController.abort(sessionId)
        : sessionController.abortBash(sessionId),
      { onSuccess: () => undefined },
    )
  }, [activeBashExecution, runScoped, state.pendingOperation])

  const handleFork = useCallback(
    (entryId: string) => {
      const sessionId = sessionIdRef.current
      if (sessionId === null) return
      setForkingEntryId(entryId)
      runScoped(sessionController.fork(sessionId, entryId), {
        onSuccess: (result) => {
          setForkingEntryId(null)
          if (!result.cancelled && result.newSessionId !== undefined) onSessionForked?.(result.newSessionId)
        },
        onFailure: (error) => {
          setForkingEntryId(null)
          addNotice({ type: "error", message: messageFor(error) })
        },
      })
    },
    [addNotice, onSessionForked, runScoped],
  )

  const loadContext = useCallback(
    (leafId: string | null) => {
      const sessionId = sessionIdRef.current
      if (sessionId === null) return
      contextSequenceRef.current += 1
      const requestId = contextSequenceRef.current
      dispatch({ _tag: "ContextRequested", sessionId, requestId })
      runScoped(sessionController.context(sessionId, leafId ?? undefined), {
        onSuccess: ({ context, beforeEntryId, hasMoreBefore }) =>
          dispatch({
            _tag: "ContextLoaded",
            sessionId,
            requestId,
            context,
            leafId,
            page: { beforeEntryId, hasMoreBefore },
          }),
        onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
      })
    },
    [addNotice, runScoped],
  )

  const loadEarlier = useCallback(() => {
    const sessionId = sessionIdRef.current
    const beforeEntryId = state.snapshot?.contextPage.beforeEntryId
    if (sessionId === null || beforeEntryId === null || beforeEntryId === undefined || loadingEarlier) return
    contextSequenceRef.current += 1
    const requestId = contextSequenceRef.current
    setLoadingEarlier(true)
    dispatch({ _tag: "ContextRequested", sessionId, requestId })
    runScoped(sessionController.context(sessionId, activeLeafId ?? undefined, beforeEntryId), {
      onSuccess: (page) => {
        setLoadingEarlier(false)
        dispatch({ _tag: "ContextPrepended", sessionId, requestId, page })
      },
      onFailure: (error) => {
        setLoadingEarlier(false)
        addNotice({ type: "error", message: messageFor(error) })
      },
    })
  }, [activeLeafId, addNotice, loadingEarlier, runScoped, state.snapshot?.contextPage.beforeEntryId])

  const handleNavigate = useCallback(
    (entryId: string) => {
      const sessionId = sessionIdRef.current
      if (sessionId === null) return
      runScoped(sessionController.navigate(sessionId, entryId), {
        onSuccess: () => loadContext(entryId),
        onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
      })
    },
    [addNotice, loadContext, runScoped],
  )

  const handleLeafChange = useCallback(
    (leafId: string | null) => {
      if (leafId === null) {
        loadContext(null)
        return
      }
      handleNavigate(leafId)
    },
    [handleNavigate, loadContext],
  )

  useEffect(() => {
    onBranchDataChange?.(data?.branchNodes ?? [], activeLeafId, handleLeafChange)
  }, [activeLeafId, data?.branchNodes, handleLeafChange, onBranchDataChange])

  useEffect(() => {
    onSystemPromptChange?.(snapshot?.runtime?.systemPrompt ?? null)
  }, [onSystemPromptChange, snapshot?.runtime?.systemPrompt])

  const handleModelChange = useCallback(
    (provider: string, modelId: string) => {
      withSession((sessionId) =>
        runScoped(sessionController.setModel(sessionId, provider, modelId), {
          onSuccess: () => loadSnapshot(sessionId),
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        }),
      )
    },
    [addNotice, loadSnapshot, runScoped, withSession],
  )

  const handleCompact = useCallback(() => {
    const sessionId = sessionIdRef.current
    if (sessionId === null || state.isCompacting) return
    dispatch({ _tag: "OperationPending", sessionId, kind: "compaction" })
    runScoped(sessionController.compact(sessionId), {
      onSuccess: ({ runId }) => {
        dispatch({ _tag: "OperationAccepted", sessionId, kind: "compaction", runId })
      },
      onFailure: (error) =>
        dispatch({ _tag: "OperationFailed", sessionId, kind: "compaction", message: messageFor(error) }),
    })
  }, [runScoped, state.isCompacting])

  const handleAbortCompaction = useCallback(() => {
    const sessionId = sessionIdRef.current
    if (sessionId !== null) runScoped(sessionController.abortCompaction(sessionId), { onSuccess: () => undefined })
  }, [runScoped])

  const queueImages = (images?: AttachedImage[]) =>
    images?.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    }))

  const handleSteer = useCallback(
    (message: string, images?: AttachedImage[]) => {
      const sessionId = sessionIdRef.current
      if (sessionId !== null)
        runScoped(sessionController.steer(sessionId, message, queueImages(images)), {
          onSuccess: () => undefined,
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
    },
    [addNotice, runScoped],
  )

  const handleFollowUp = useCallback(
    (message: string, images?: AttachedImage[]) => {
      const sessionId = sessionIdRef.current
      if (sessionId !== null)
        runScoped(sessionController.followUp(sessionId, message, queueImages(images)), {
          onSuccess: () => undefined,
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
    },
    [addNotice, runScoped],
  )

  const handlePromptWithStreamingBehavior = useCallback(
    (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
      const sessionId = sessionIdRef.current
      if (sessionId !== null)
        runScoped(
          behavior === "steer"
            ? sessionController.steer(sessionId, message, queueImages(images))
            : sessionController.followUp(sessionId, message, queueImages(images)),
          {
            onSuccess: () => undefined,
            onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
          },
        )
    },
    [addNotice, runScoped],
  )

  const handleRecallQueue = useCallback(() => {
    const sessionId = sessionIdRef.current
    if (sessionId === null) return
    runScoped(sessionController.clearQueue(sessionId), {
      onSuccess: (queued) => {
        const text = [...queued.steering, ...queued.followUp].join("\n\n")
        if (text) chatInputRef?.current?.prependText(text)
      },
      onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
    })
  }, [addNotice, chatInputRef, runScoped])

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevelOption) => {
      setThinkingLevel(level)
      if (level === "auto") return
      withSession((sessionId) =>
        runScoped(sessionController.setThinking(sessionId, level), {
          onSuccess: () => undefined,
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        }),
      )
    },
    [addNotice, runScoped, withSession],
  )

  const loadTools = useCallback(
    (sessionId = sessionIdRef.current) => {
      if (sessionId === null) return
      runScoped(sessionController.tools(sessionId), {
        onSuccess: ({ tools }) => {
          const preset = getPresetFromTools(tools.map((tool) => ({ ...tool })))
          setToolPreset(preset)
          onToolPresetChange?.(preset)
        },
      })
    },
    [onToolPresetChange, runScoped],
  )

  const handleToolPresetChange = useCallback(
    (preset: ToolPreset) => {
      setToolPreset(preset)
      onToolPresetChange?.(preset)
      withSession((sessionId) =>
        runScoped(sessionController.setTools(sessionId, getToolNamesForPreset(preset)), {
          onSuccess: () => loadTools(sessionId),
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        }),
      )
    },
    [addNotice, loadTools, onToolPresetChange, runScoped, withSession],
  )

  useEffect(() => {
    if (activeSessionId !== null) loadTools(activeSessionId)
  }, [activeSessionId, loadTools, sessionRefreshKey])

  const loadSlashCommands = useCallback((): SlashCommandInfo[] => {
    const sessionId = sessionIdRef.current
    if (sessionId === null) return slashCommands
    setSlashCommandsLoading(true)
    runScoped(sessionController.commands(sessionId), {
      onSuccess: ({ commands }) => {
        setSlashCommands(
          commands.map((command) => ({
            name: command.name,
            ...(command.description === undefined ? {} : { description: command.description }),
            source: command.source,
            sourceInfo: command.sourceInfo as SlashCommandInfo["sourceInfo"],
          })),
        )
        setSlashCommandsLoading(false)
      },
      onFailure: () => setSlashCommandsLoading(false),
    })
    return slashCommands
  }, [runScoped, slashCommands])

  const respondToExtensionUi = useCallback(
    (request: ExtensionDialog, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
      const sessionId = sessionIdRef.current
      const runtimeId = state.runtimeIdentity?.runtimeId
      if (sessionId === null || runtimeId === undefined) return
      const payload =
        "cancelled" in response
          ? ({ _tag: "Cancelled" } as const)
          : "confirmed" in response
            ? ({ _tag: "Confirmation", confirmed: response.confirmed } as const)
            : ({ _tag: "Value", value: response.value } as const)
      runScoped(
        sessionController.resolveInteraction(sessionId, runtimeId, request.interactionId, { answer: payload }),
        {
          onSuccess: () => undefined,
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        },
      )
    },
    [addNotice, runScoped, state.runtimeIdentity],
  )

  const handleBuiltinSlashCommand = useCallback(
    (text: string): BuiltinSlashCommandResult => {
      const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      if (match === null) return { handled: false }
      const command = match[1]
      const args = (match[2] ?? "").trim()
      if (command === "compact") {
        const sessionId = sessionIdRef.current
        if (sessionId === null) return { handled: true, error: "No active session to compact" }
        dispatch({ _tag: "OperationPending", sessionId, kind: "compaction" })
        runScoped(sessionController.compact(sessionId, args || undefined), {
          onSuccess: ({ runId }) => {
            dispatch({ _tag: "OperationAccepted", sessionId, kind: "compaction", runId })
          },
          onFailure: (error) =>
            dispatch({ _tag: "OperationFailed", sessionId, kind: "compaction", message: messageFor(error) }),
        })
        return { handled: true }
      }
      if (command === "reload") {
        const sessionId = sessionIdRef.current
        if (sessionId === null) return { handled: true, error: "No active session to reload" }
        runScoped(sessionController.reload(sessionId), {
          onSuccess: () => {
            loadSnapshot(sessionId)
            loadTools(sessionId)
            loadSlashCommands()
          },
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
        return { handled: true }
      }
      if (command === "name") {
        const sessionId = sessionIdRef.current
        if (sessionId === null || !args) return { handled: true, error: "Usage: /name <name>" }
        runScoped(sessionController.rename(sessionId, args), {
          onSuccess: () => loadSnapshot(sessionId),
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
        return { handled: true }
      }
      if (command === "session") {
        const sessionId = sessionIdRef.current
        if (sessionId === null) return { handled: true, error: "No active session" }
        runScoped(sessionController.stats(sessionId), {
          onSuccess: (stats) => {
            setSessionStatsOverride(stats as SessionStatsInfo)
            onSessionStatsPanelOpen?.()
          },
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
        return { handled: true, action: "openSessionStats" }
      }
      if (command === "copy") {
        const sessionId = sessionIdRef.current
        if (sessionId === null) return { handled: true, error: "No active session" }
        runScoped(
          sessionController
            .lastAssistant(sessionId)
            .pipe(Effect.flatMap(({ text }) => (text.length === 0 ? Effect.void : copyText(text)))),
          {
            onSuccess: () => addNotice({ type: "success", message: "Copied last assistant message" }),
            onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
          },
        )
        return { handled: true }
      }
      const registered = slashCommands.find((item) => item.name === command)
      if (registered?.source === "extension") {
        const sessionId = sessionIdRef.current
        if (sessionId === null) return { handled: true, error: "No active session" }
        runScoped(sessionController.slashCommand(sessionId, command, args), {
          onSuccess: () => loadTools(sessionId),
          onFailure: (error) => addNotice({ type: "error", message: messageFor(error) }),
        })
        return { handled: true }
      }
      if (registered === undefined) {
        return {
          handled: true,
          error: slashCommandsLoading ? "Slash commands are still loading" : `Unknown slash command: /${command}`,
        }
      }
      return { handled: false }
    },
    [
      addNotice,
      loadSlashCommands,
      loadSnapshot,
      loadTools,
      onSessionStatsPanelOpen,
      runScoped,
      slashCommands,
      slashCommandsLoading,
    ],
  )

  const extensionDialog = state.extensionUi.pendingInteraction as ExtensionDialog | null
  const contextUsage = snapshot?.runtime?.contextUsage ?? null
  const systemPrompt = snapshot?.runtime?.systemPrompt ?? null
  const agentPhase: AgentPhase =
    activeBashExecution !== null ? { kind: "running_command" } : state.agentRunning ? { kind: "waiting_model" } : null

  return {
    data,
    loading,
    loadingEarlier,
    hasMoreBefore: snapshot?.contextPage.hasMoreBefore ?? false,
    error: state.error,
    activeLeafId,
    transcriptSources,
    runId: state.runId,
    streamState: {
      isStreaming: state.isStreaming,
      streamingMessage: state.streamingMessage as AgentMessage | null,
    },
    agentRunning: state.agentRunning,
    activeBashExecution,
    modelNames,
    modelList,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    toolPreset,
    thinkingLevel,
    retryInfo: state.retryInfo,
    contextUsage,
    systemPrompt,
    forkingEntryId,
    isCompacting: state.isCompacting,
    compactError: state.isCompacting ? null : state.error,
    compactResult: state.compactResult,
    currentModel,
    displayModel,
    sessionStats,
    slashCommands,
    slashCommandsLoading,
    queuedMessages: {
      steering: [...state.queuedMessages.steering],
      followUp: [...state.queuedMessages.followUp],
    },
    extensionDialog,
    extensionStatuses,
    extensionWidgets,
    respondToExtensionUi,
    isAutoModelSelection: false,
    agentPhase,
    sessionIdRef,
    handleSend,
    handleBashCommand,
    handleAbort,
    handleFork,
    handleNavigate,
    loadEarlier,
    handleModelChange,
    handleCompact,
    handleSteer,
    handleFollowUp,
    handlePromptWithStreamingBehavior,
    handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange,
    handleThinkingLevelChange,
    loadTools,
    loadSlashCommands,
  }
}
