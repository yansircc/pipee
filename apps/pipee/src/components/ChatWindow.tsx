import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import type { DropPayload } from "@/lib/drop-paths"
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  ExtensionInteraction,
  ExtensionStatusContribution,
  ExtensionWidgetItem,
  SessionInfo,
  SessionStats,
  SessionBranchNode,
  ToolResultMessage,
  WeixinStatusProjection,
} from "@/api/contract"
import {
  partitionAssistantBlocks,
  segmentAssistantBlocks,
  summarizeTurnUsage,
  type TurnUsage,
} from "@/lib/message-display"
import { MessageView, ProcessMessageView, StreamingThroughputBadge, TurnUsageSummary } from "./MessageView"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { ChatMinimap, useMessageRefs } from "./ChatMinimap"
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession"
import { useAudio } from "@/hooks/useAudio"
import { useDragDrop } from "@/hooks/useDragDrop"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import { getWeixinStatusProjection, sameWeixinStatusProjection } from "@/lib/extension-status"
import { runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { CompanionRendererRegistry } from "@/features/companions/renderer-registry"
interface Props {
  session: SessionInfo
  sessionRefreshKey: number
  inputFocusEpoch?: number
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
  onSystemPromptChange?: (
    state:
      | { readonly sessionId: string; readonly status: "loading" }
      | { readonly error: string; readonly sessionId: string; readonly status: "error" }
      | { readonly prompt: string; readonly sessionId: string; readonly status: "ready" },
  ) => void
  onSessionStatsChange?: (stats: SessionStats | null) => void
  onSessionStatsPanelOpen?: () => void
  onContextUsageChange?: (
    usage: {
      percent: number | null
      contextWindow: number
      tokens: number | null
    } | null,
  ) => void
  onWeixinStatusChange?: (status: WeixinStatusProjection) => void
  onOpenFile?: (filePath: string) => void
  onOpenModels?: () => void
  onOpenSkills?: () => void
  skillsCount?: number
  cancelActivityEpoch?: number
  onActivityStateChange?: (state: { readonly busy: boolean; readonly blockingDialog: boolean }) => void
  onCancelActivity?: () => void
  cancelShortcut?: string
  focusComposerAriaKeyshortcuts?: string
}
function phaseLabel(phase: AgentPhase, t: (source: string) => string): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name)
    if (names.length === 0) return t("Running tool...")
    if (names.length === 1) return `${t("Running")}: ${names[0]}…`
    if (names.length <= 3) return `${t("Running")}: ${names.join(", ")}…`
    return `${t("Running")}: ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`
  }
  if (phase?.kind === "waiting_model") return t("Waiting for model...")
  if (phase?.kind === "running_command") return t("Running command...")
  return t("Thinking...")
}
const CHAT_MINIMAP_WIDTH = 36
const CHAT_COLUMN_PADDING = 16
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH
const dropZoneIn = stylex.keyframes({
  from: {
    opacity: 0,
    transform: "scale(0.97)",
  },
  to: {
    opacity: 1,
    transform: "scale(1)",
  },
})
const dropRipple = stylex.keyframes({
  from: {
    opacity: 0.6,
    transform: "scale(0)",
  },
  to: {
    opacity: 0,
    transform: "scale(1)",
  },
})
const pulse = stylex.keyframes({
  "0%, 100%": {
    opacity: 1,
  },
  "50%": {
    opacity: 0.5,
  },
})
const spin = stylex.keyframes({
  to: { transform: "rotate(360deg)" },
})
function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: {
    omitTermination?: boolean
    omitUsage?: boolean
  } = {},
): AssistantMessage {
  const next = {
    ...message,
    content,
  }
  if (options.omitTermination) {
    next.stopReason = undefined
    next.errorMessage = undefined
  }
  if (options.omitUsage) next.usage = undefined
  return next
}
function describeActivity(message: AgentMessage, locale: string): string {
  if (message.role !== "assistant") return locale === "zh-CN" ? "扩展事件" : "Extension event"
  const toolNames = partitionAssistantBlocks(message as AssistantMessage)
    .processBlocks.filter((block) => block.type === "toolCall")
    .map((block) => block.toolName.toLowerCase())
  if (toolNames.length === 0) return locale === "zh-CN" ? "思考" : "Thinking"
  const hasBrowser = toolNames.some((name) => name.startsWith("chrome_") || name.includes("browser"))
  const hasEdits = toolNames.some((name) => /(^|_)(edit|write|patch|apply_patch)($|_)/.test(name))
  const hasCommands = toolNames.some((name) => /(^|_)(bash|shell|exec|command)($|_)/.test(name))
  const hasReads = toolNames.some((name) => /(^|_)(read|grep|find|ls|search)($|_)/.test(name))
  if (locale === "zh-CN") {
    if (hasBrowser) return "操作了浏览器"
    if (hasEdits && hasCommands) return "编辑了文件并运行命令"
    if (hasEdits) return "编辑了文件"
    if (hasReads && hasCommands) return "读取文件并运行命令"
    if (hasCommands) return toolNames.length === 1 ? "运行了命令" : "运行了多个命令"
    if (hasReads) return "读取了文件"
    return toolNames.length === 1 ? `调用了 ${toolNames[0]}` : `调用了 ${toolNames.length} 个工具`
  }
  if (hasBrowser) return "Used the browser"
  if (hasEdits && hasCommands) return "Edited files and ran commands"
  if (hasEdits) return "Edited files"
  if (hasReads && hasCommands) return "Read files and ran commands"
  if (hasCommands) return toolNames.length === 1 ? "Ran a command" : "Ran multiple commands"
  if (hasReads) return "Read files"
  return toolNames.length === 1 ? `Called ${toolNames[0]}` : `Called ${toolNames.length} tools`
}

function ActivityGroup({
  message,
  running,
  children,
}: {
  message: AgentMessage
  running: boolean
  children: ReactNode
}) {
  const { locale, t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  return (
    <div aria-busy={running} {...stylex.props(inlineStyles.activityGroup)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        {...stylex.props(inlineStyles.activityToggle)}
        title={t(expanded ? "Collapse process details" : "Expand process details")}
      >
        {running ? (
          <span {...stylex.props(inlineStyles.processStateDot)} aria-hidden="true" />
        ) : (
          <span {...stylex.props(inlineStyles.activityComplete)} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
              <polyline points="2.5 6 5 8.5 9.5 3.5" />
            </svg>
          </span>
        )}
        <strong {...stylex.props(inlineStyles.activityTitle)}>{describeActivity(message, locale)}</strong>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...stylex.props(inlineStyles.activityChevron)}
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
          }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
      </button>
      {expanded && <div {...stylex.props(inlineStyles.activityBody)}>{children}</div>}
    </div>
  )
}
export function ChatWindow({
  session,
  sessionRefreshKey,
  inputFocusEpoch = 0,
  onAgentEnd,
  onSessionIndexChanged,
  onSessionForked,
  modelsRefreshKey,
  chatInputRef,
  onBranchDataChange,
  onSystemPromptChange,
  onSessionStatsChange,
  onSessionStatsPanelOpen,
  onContextUsageChange,
  onWeixinStatusChange,
  onOpenFile,
  onOpenModels,
  onOpenSkills,
  skillsCount,
  cancelActivityEpoch = 0,
  onActivityStateChange,
  onCancelActivity,
  cancelShortcut,
  focusComposerAriaKeyshortcuts,
}: Props) {
  const { t } = useI18n()
  const { soundEnabled, playDoneSound, unlockAudio } = useAudio()
  const isMobile = useIsMobile()

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound)
  playDoneSoundRef.current = playDoneSound
  const soundEnabledRef = useRef(soundEnabled)
  soundEnabledRef.current = soundEnabled
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current()
    }
    onAgentEnd?.()
  }, [onAgentEnd])
  const {
    loading,
    loadingEarlier,
    hasMoreBefore,
    error,
    messages,
    entryIds,
    streamState,
    agentRunning,
    activeBashExecution,
    modelNames,
    modelList,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    toolPreset,
    thinkingLevel,
    retryInfo,
    contextUsage,
    systemPrompt,
    forkingEntryId,
    isCompacting,
    compactError,
    compactResult,
    displayModel: displayModelValue,
    sessionStats,
    slashCommands,
    slashCommandsLoading,
    queuedMessages,
    extensionDialog,
    extensionStatuses,
    extensionWidgets,
    respondToExtensionUi,
    isAutoModelSelection,
    agentPhase,
    messagesEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend,
    handleBashCommand,
    handleAbort,
    handleFork,
    handleNavigate,
    loadEarlier,
    handleModelChange,
    handleSteer,
    handleFollowUp,
    handlePromptWithStreamingBehavior,
    handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleThinkingLevelChange,
    loadSlashCommands,
  } = useAgentSession({
    session,
    sessionRefreshKey,
    onAgentEnd: wrappedOnAgentEnd,
    onSessionIndexChanged,
    onSessionForked,
    modelsRefreshKey,
    chatInputRef,
    onBranchDataChange,
    onSessionStatsPanelOpen,
  })
  useEffect(() => {
    if (loading) {
      onSystemPromptChange?.({ sessionId: session.id, status: "loading" })
    } else if (error) {
      onSystemPromptChange?.({ sessionId: session.id, status: "error", error: String(error) })
    } else if (systemPrompt !== null) {
      onSystemPromptChange?.({ sessionId: session.id, status: "ready", prompt: systemPrompt })
    }
  }, [error, loading, onSystemPromptChange, session.id, systemPrompt])
  const sessionBusy = agentRunning || activeBashExecution !== null
  const previousCancelEpoch = useRef(cancelActivityEpoch)
  useEffect(() => {
    if (cancelActivityEpoch <= previousCancelEpoch.current) return
    previousCancelEpoch.current = cancelActivityEpoch
    handleAbort()
  }, [cancelActivityEpoch, handleAbort])
  useEffect(() => {
    onActivityStateChange?.({ busy: sessionBusy, blockingDialog: extensionDialog !== null })
  }, [extensionDialog, onActivityStateChange, sessionBusy])
  useEffect(() => () => onActivityStateChange?.({ busy: false, blockingDialog: false }), [onActivityStateChange])
  const activeBashOutputLength = activeBashExecution?.output.length
  const [followingLatest, setFollowingLatestState] = useState(true)
  const followingLatestRef = useRef(true)
  const setFollowingLatest = useCallback((following: boolean) => {
    followingLatestRef.current = following
    setFollowingLatestState(following)
  }, [])
  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior) => {
      const target = messagesEndRef.current
      if (target === null) return
      setFollowingLatest(true)
      runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.scrollElementIntoView(target, behavior))), {
        onSuccess: () => undefined,
      })
    },
    [messagesEndRef, setFollowingLatest],
  )
  useEffect(() => {
    if (!loading && inputFocusEpoch > 0) chatInputRef?.current?.focus()
  }, [chatInputRef, inputFocusEpoch, loading])
  useEffect(() => {
    setFollowingLatest(true)
  }, [session.id, setFollowingLatest])
  useEffect(() => {
    const container = scrollContainerRef.current
    const target = messagesEndRef.current
    if (container === null || target === null) return
    return runBrowser(
      BrowserPlatform.pipe(
        Effect.flatMap((browser) =>
          browser.watchElementNearViewportEnd(container, target, 48, (nearEnd) => setFollowingLatest(nearEnd)),
        ),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [messages.length, messagesEndRef, scrollContainerRef, session.id, setFollowingLatest])
  useEffect(() => {
    if (!followingLatestRef.current) return
    scrollToLatest("auto")
  }, [activeBashOutputLength, agentPhase, messages, scrollToLatest, streamState.streamingMessage])

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
        sessionStats.sessionId,
        sessionStats.sessionFile ?? "",
        sessionStats.sessionName ?? "",
        sessionStats.userMessages,
        sessionStats.assistantMessages,
        sessionStats.toolCalls,
        sessionStats.toolResults,
        sessionStats.totalMessages,
        sessionStats.tokens.input,
        sessionStats.tokens.output,
        sessionStats.tokens.cacheRead,
        sessionStats.tokens.cacheWrite,
        sessionStats.tokens.total,
        sessionStats.cost ?? 0,
      ].join("|")
    : null
  const sessionStatsRef = useRef(sessionStats)
  sessionStatsRef.current = sessionStats
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current)
  }, [statsKey, onSessionStatsChange])

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null
  const contextUsageRef = useRef(contextUsage)
  contextUsageRef.current = contextUsage
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current)
  }, [ctxKey, onContextUsageChange])
  const weixinStatus = getWeixinStatusProjection(extensionStatuses)
  const publishedWeixinStatusRef = useRef<WeixinStatusProjection | undefined>(undefined)
  useEffect(() => {
    if (weixinStatus === undefined) return
    const published = publishedWeixinStatusRef.current
    if (published !== undefined && sameWeixinStatusProjection(published, weixinStatus)) return
    publishedWeixinStatusRef.current = weixinStatus
    onWeixinStatusChange?.(weixinStatus)
  }, [onWeixinStatusChange, weixinStatus])
  const onDrop = useCallback(
    (payload: DropPayload) => {
      if (sessionBusy) return
      if (payload.hasDirectory || payload.paths.some((entry) => entry.isDirectory)) return
      chatInputRef?.current?.addFiles(
        payload.files,
        payload.paths.map((entry) => entry.path),
      )
    },
    [sessionBusy, chatInputRef],
  )
  const { isDragOver, dragKind, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop)
  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant")
  const messageRefs = useMessageRefs(visibleMessages.length)
  const runInProgress = agentRunning || streamState.isStreaming
  const liveUserIndex = runInProgress ? messages.findLastIndex((message) => message.role === "user") : -1
  const liveTurnUsage = liveUserIndex >= 0 ? summarizeTurnUsage(messages, liveUserIndex, messages.length) : null
  const isEmptySession = messages.length === 0 && !streamState.isStreaming && !sessionBusy
  const messageCwd = session.cwd
  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null
  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null
  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onBashCommand={handleBashCommand}
      onAbort={onCancelActivity ?? handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      isBashRunning={activeBashExecution !== null}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      onModelChange={handleModelChange}
      onOpenModels={onOpenModels}
      onOpenSkills={onOpenSkills}
      skillsCount={skillsCount}
      cancelShortcut={cancelShortcut}
      focusComposerAriaKeyshortcuts={focusComposerAriaKeyshortcuts}
      sessionStats={sessionStats}
      contextUsage={contextUsage}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={handleThinkingLevelChange}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      onAudioUnlock={unlockAudio}
      draftKey={session.id}
      cwd={session.cwd}
    />
  )
  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor")
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor")
  if (loading) {
    return <div {...stylex.props(styles.centeredState)}>Loading session...</div>
  }
  if (error) {
    return <div {...stylex.props(styles.centeredState, styles.error)}>{error}</div>
  }
  return (
    <div
      {...stylex.props(styles.root)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !agentRunning && (
        <div {...stylex.props(styles.dropZone)}>
          <div {...stylex.props(styles.dropRippleLayer)}>
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                {...stylex.props(styles.dropRipple)}
                {...stylex.props(inlineStyles.inline6)}
                style={{
                  animationDelay: `${delay}s`,
                }}
              />
            ))}
          </div>
          <div {...stylex.props(inlineStyles.inline7)}>
            <svg
              width="280"
              height="280"
              viewBox="0 0 140 140"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              {...stylex.props(styles.dropIllustration)}
            >
              <rect
                x="28"
                y="44"
                width="84"
                height="60"
                rx="8"
                fill="rgba(37,99,235,0.08)"
                stroke="rgba(37,99,235,0.50)"
                strokeWidth="1.8"
              />
              <path
                d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
                fill="rgba(37,99,235,0.16)"
                stroke="rgba(37,99,235,0.40)"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <circle
                cx="96"
                cy="58"
                r="8"
                fill="rgba(37,99,235,0.22)"
                stroke="rgba(37,99,235,0.55)"
                strokeWidth="1.6"
              />
              <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
                <line x1="96" y1="46" x2="96" y2="43" />
                <line x1="96" y1="70" x2="96" y2="73" />
                <line x1="84" y1="58" x2="81" y2="58" />
                <line x1="108" y1="58" x2="111" y2="58" />
                <line x1="87.5" y1="49.5" x2="85.4" y2="47.4" />
                <line x1="104.5" y1="66.5" x2="106.6" y2="68.6" />
                <line x1="104.5" y1="49.5" x2="106.6" y2="47.4" />
                <line x1="87.5" y1="66.5" x2="85.4" y2="68.6" />
              </g>
            </svg>
            <div {...stylex.props(inlineStyles.inline8)}>
              {dragKind === "directory"
                ? t("Use the top-left project picker to select a folder")
                : t("Drop files to attach")}
            </div>
          </div>
        </div>
      )}

      {extensionDialog && <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />}

      {isEmptySession ? (
        <div {...stylex.props(styles.emptySession)}>
          <div {...stylex.props(styles.chatColumn)}>
            <div {...stylex.props(styles.emptyHeader)} {...stylex.props(inlineStyles.inline9)}>
              <div {...stylex.props(inlineStyles.inline10)}>
                <span {...stylex.props(inlineStyles.inline11)}>π</span>
                <span {...stylex.props(inlineStyles.inline12)}>Pipee</span>
              </div>
              <div {...stylex.props(inlineStyles.inline13)}>
                <span {...stylex.props(inlineStyles.inline14)}>
                  pipee <span {...stylex.props(inlineStyles.inline15)}>v{__APP_VERSION__}</span>
                </span>
                <span {...stylex.props(inlineStyles.inline16)}>
                  pi <span {...stylex.props(inlineStyles.inline17)}>v{__PI_VERSION__}</span>
                </span>
              </div>
            </div>
            {chatInputElement}
          </div>
        </div>
      ) : (
        <>
          <div {...stylex.props(styles.conversation)}>
            <div ref={scrollContainerRef} data-testid="chat-scroll-container" {...stylex.props(styles.scroller)}>
              <div
                style={{
                  padding: `0 ${CHAT_COLUMN_PADDING}px`,
                  paddingLeft: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
                }}
              >
                <div {...stylex.props(inlineStyles.inline20)}>
                  <CompanionRendererRegistry statuses={extensionStatuses} sessionId={session.id} />
                  <ExtensionStatusBar statuses={extensionStatuses} />
                  <ExtensionWidgets widgets={aboveEditorWidgets} />

                  {hasMoreBefore && (
                    <div {...stylex.props(inlineStyles.inline21)}>
                      <button
                        type="button"
                        disabled={loadingEarlier}
                        onClick={loadEarlier}
                        {...stylex.props(inlineStyles.inline22)}
                        style={{
                          cursor: loadingEarlier ? "default" : "pointer",
                          opacity: loadingEarlier ? 0.6 : 1,
                        }}
                      >
                        {t(loadingEarlier ? "Loading..." : "Load earlier messages")}
                      </button>
                    </div>
                  )}

                  {(() => {
                    const toolResultsMap = new Map<string, ToolResultMessage>()
                    for (const msg of messages) {
                      if (msg.role === "toolResult") {
                        toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage)
                      }
                    }
                    let lastUserIdx = -1
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "user") {
                        lastUserIdx = i
                        break
                      }
                    }
                    const visibleRefIndexByMessage = new Map<number, number>()
                    let refIdx = 0
                    messages.forEach((msg, idx) => {
                      if (msg.role === "user" || msg.role === "assistant") {
                        visibleRefIndexByMessage.set(idx, refIdx++)
                      }
                    })
                    const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                      messageRefs.current[refIndex] = el
                      if (idx === lastUserIdx) {
                        ;(
                          lastUserMsgRef as {
                            current: HTMLDivElement | null
                          }
                        ).current = el
                      }
                    }
                    const renderMessage = (
                      idx: number,
                      options: {
                        attachRef?: boolean
                        keyPrefix?: string
                        messageOverride?: AgentMessage
                        showTimestamp?: boolean
                        turnUsage?: TurnUsage
                        hideUsage?: boolean
                        turnSegment?: boolean
                      } = {},
                    ): ReactNode => {
                      const msg = options.messageOverride ?? messages[idx]
                      const prevAssistantEntryId =
                        msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                          ? entryIds[idx - 1]
                          : undefined
                      const isVisible = msg.role === "user" || msg.role === "assistant"
                      const currentRefIdx = visibleRefIndexByMessage.get(idx)
                      const keyPrefix = options.keyPrefix ?? "message"
                      let showTimestamp = false
                      if (msg.role === "assistant") {
                        showTimestamp = true
                        for (let j = idx + 1; j < messages.length; j++) {
                          const r = messages[j].role
                          if (r === "user") break
                          if (r === "assistant") {
                            showTimestamp = false
                            break
                          }
                        }
                        // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                        if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                          showTimestamp = false
                        }
                      }
                      if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp
                      const view = (
                        <MessageView
                          key={`${keyPrefix}-view-${idx}`}
                          message={msg}
                          toolResults={toolResultsMap}
                          modelNames={modelNames}
                          cwd={messageCwd}
                          onOpenFile={onOpenFile}
                          entryId={entryIds[idx]}
                          onFork={sessionBusy || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                          forking={forkingEntryId === entryIds[idx]}
                          onNavigate={sessionBusy ? undefined : handleNavigate}
                          prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                          onEditContent={(content) => chatInputRef?.current?.insertIfEmpty(content)}
                          showTimestamp={showTimestamp}
                          prevTimestamp={
                            idx > 0
                              ? (
                                  messages[idx - 1] as AgentMessage & {
                                    timestamp?: number
                                  }
                                ).timestamp
                              : undefined
                          }
                          sessionId={session.id}
                          turnUsage={options.turnUsage}
                          hideUsage={options.hideUsage}
                          turnSegment={options.turnSegment}
                        />
                      )
                      if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view
                      return (
                        <div key={`${keyPrefix}-${idx}`} ref={attachVisibleRef(idx, currentRefIdx)}>
                          {view}
                        </div>
                      )
                    }
                    const rendered: ReactNode[] = []
                    for (let idx = 0; idx < messages.length; ) {
                      const msg = messages[idx]
                      if (msg.role !== "user") {
                        rendered.push(renderMessage(idx))
                        idx += 1
                        continue
                      }
                      const userIdx = idx
                      let endIdx = userIdx + 1
                      while (endIdx < messages.length && messages[endIdx].role !== "user") endIdx += 1
                      const turnUsage = summarizeTurnUsage(messages, userIdx, endIdx)
                      const isLiveTail = runInProgress && endIdx === messages.length && userIdx === lastUserIdx
                      rendered.push(renderMessage(userIdx))
                      const streamingAssistant =
                        isLiveTail && streamState.streamingMessage?.role === "assistant"
                          ? (streamState.streamingMessage as AssistantMessage)
                          : null
                      const streamingSegments = streamingAssistant
                        ? segmentAssistantBlocks(streamingAssistant, { isStreaming: true })
                        : []
                      const persistedProcessIndices: number[] = []
                      for (let messageIdx = userIdx + 1; messageIdx < endIdx; messageIdx++) {
                        const turnMessage = messages[messageIdx]
                        if (turnMessage.role === "assistant") {
                          if (
                            segmentAssistantBlocks(turnMessage as AssistantMessage).some(
                              ({ kind }) => kind === "process",
                            )
                          ) {
                            persistedProcessIndices.push(messageIdx)
                          }
                        }
                      }
                      const streamingHasProcess = streamingSegments.some(({ kind }) => kind === "process")
                      const runningPersistedProcessIdx =
                        isLiveTail && !streamingHasProcess ? persistedProcessIndices.at(-1) : undefined
                      const turnSegments: ReactNode[] = []
                      for (let messageIdx = userIdx + 1; messageIdx < endIdx; messageIdx++) {
                        const turnMessage = messages[messageIdx]
                        if (turnMessage.role === "toolResult") continue
                        if (turnMessage.role !== "assistant") {
                          if (turnMessage.role === "custom") {
                            turnSegments.push(
                              <ActivityGroup key={`activity-${messageIdx}`} message={turnMessage} running={false}>
                                <ProcessMessageView
                                  message={turnMessage}
                                  toolResults={toolResultsMap}
                                  prevTimestamp={messages[messageIdx - 1]?.timestamp}
                                  sessionId={session.id}
                                  entryId={entryIds[messageIdx]}
                                />
                              </ActivityGroup>,
                            )
                          } else {
                            turnSegments.push(renderMessage(messageIdx, { turnSegment: true }))
                          }
                          continue
                        }
                        const assistant = turnMessage as AssistantMessage
                        const segments = segmentAssistantBlocks(assistant)
                        const lastProcessSegment = segments.findLastIndex(({ kind }) => kind === "process")
                        segments.forEach((segment, segmentIndex) => {
                          const segmentMessage = withAssistantBlocks(assistant, [...segment.blocks], {
                            omitTermination: true,
                            omitUsage: true,
                          })
                          if (segment.kind === "event") {
                            turnSegments.push(
                              renderMessage(messageIdx, {
                                attachRef: segmentIndex === 0,
                                hideUsage: true,
                                keyPrefix: `turn-event-${segmentIndex}`,
                                messageOverride: segmentMessage,
                                showTimestamp: false,
                                turnSegment: true,
                              }),
                            )
                            return
                          }
                          const activityRefIdx =
                            segmentIndex === 0 ? visibleRefIndexByMessage.get(messageIdx) : undefined
                          turnSegments.push(
                            <div
                              key={`activity-${messageIdx}-${segmentIndex}`}
                              ref={
                                activityRefIdx === undefined
                                  ? undefined
                                  : (element) => {
                                      messageRefs.current[activityRefIdx] = element
                                    }
                              }
                            >
                              <ActivityGroup
                                message={segmentMessage}
                                running={
                                  messageIdx === runningPersistedProcessIdx && segmentIndex === lastProcessSegment
                                }
                              >
                                <ProcessMessageView
                                  message={segmentMessage}
                                  toolResults={toolResultsMap}
                                  prevTimestamp={
                                    messageIdx > 0 ? (messages[messageIdx - 1] as AgentMessage).timestamp : undefined
                                  }
                                  sessionId={session.id}
                                  entryId={entryIds[messageIdx]}
                                />
                              </ActivityGroup>
                            </div>,
                          )
                        })
                        if (assistant.stopReason === "aborted" || assistant.errorMessage?.trim()) {
                          turnSegments.push(
                            renderMessage(messageIdx, {
                              attachRef: segments.length === 0,
                              hideUsage: true,
                              keyPrefix: "turn-termination",
                              messageOverride: withAssistantBlocks(assistant, [], { omitUsage: true }),
                              showTimestamp: false,
                              turnSegment: true,
                            }),
                          )
                        }
                      }
                      if (streamingAssistant) {
                        const lastStreamingProcess = streamingSegments.findLastIndex(({ kind }) => kind === "process")
                        streamingSegments.forEach((segment, segmentIndex) => {
                          const segmentMessage = withAssistantBlocks(streamingAssistant, [...segment.blocks], {
                            omitTermination: true,
                            omitUsage: true,
                          })
                          turnSegments.push(
                            segment.kind === "event" ? (
                              <MessageView
                                key={`streaming-event-${userIdx}-${segmentIndex}`}
                                message={segmentMessage}
                                isStreaming
                                modelNames={modelNames}
                                cwd={messageCwd}
                                onOpenFile={onOpenFile}
                                turnSegment
                              />
                            ) : (
                              <ActivityGroup
                                key={`streaming-activity-${userIdx}-${segmentIndex}`}
                                message={segmentMessage}
                                running={segmentIndex === lastStreamingProcess}
                              >
                                <ProcessMessageView
                                  message={segmentMessage}
                                  toolResults={toolResultsMap}
                                  prevTimestamp={messages.at(-1)?.timestamp}
                                  sessionId={session.id}
                                />
                              </ActivityGroup>
                            ),
                          )
                        })
                      }
                      const footerUsage = isLiveTail ? liveTurnUsage : turnUsage
                      const turnTimestamp = messages
                        .slice(userIdx + 1, endIdx)
                        .findLast((message) => message.role === "assistant")?.timestamp
                      if (streamingAssistant || footerUsage) {
                        turnSegments.push(
                          <div key={`turn-metrics-${userIdx}`} {...stylex.props(inlineStyles.turnMetrics)}>
                            {streamingAssistant && <StreamingThroughputBadge message={streamingAssistant} />}
                            {footerUsage && (
                              <TurnUsageSummary
                                modelNames={modelNames}
                                usage={footerUsage}
                                ongoing={isLiveTail}
                                timestamp={turnTimestamp}
                              />
                            )}
                          </div>,
                        )
                      }
                      if (turnSegments.length > 0) {
                        rendered.push(
                          <div key={`assistant-turn-${userIdx}`} {...stylex.props(inlineStyles.assistantTurn)}>
                            {turnSegments}
                          </div>,
                        )
                      }
                      idx = endIdx
                    }
                    return rendered
                  })()}

                  {streamState.isStreaming && streamState.streamingMessage && liveUserIndex < 0 && (
                    <>
                      <MessageView
                        message={streamState.streamingMessage as AgentMessage}
                        isStreaming
                        modelNames={modelNames}
                        cwd={messageCwd}
                        onOpenFile={onOpenFile}
                      />
                      {streamState.streamingMessage.role === "assistant" && (
                        <StreamingThroughputBadge message={streamState.streamingMessage as AssistantMessage} />
                      )}
                    </>
                  )}

                  {activeBashExecution && (
                    <MessageView
                      message={
                        {
                          role: "bashExecution",
                          command: activeBashExecution.command,
                          output: activeBashExecution.output,
                          exitCode: undefined,
                          cancelled: false,
                          truncated: false,
                          timestamp: activeBashExecution.startedAt,
                          excludeFromContext: activeBashExecution.excludeFromContext,
                        } satisfies BashExecutionMessage
                      }
                      isStreaming
                      cwd={messageCwd}
                      onOpenFile={onOpenFile}
                    />
                  )}

                  {agentRunning && !streamState.streamingMessage && (
                    <div {...stylex.props(styles.agentPhase)}>
                      <span {...stylex.props(styles.pulse)}>{phaseLabel(agentPhase, t)}</span>
                    </div>
                  )}

                  <div ref={messagesEndRef} />

                  {agentRunning && (
                    <div
                      style={{
                        height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
            {!followingLatest && (
              <button
                type="button"
                onClick={() => scrollToLatest("smooth")}
                title={t("Scroll to latest")}
                {...stylex.props(inlineStyles.inline25)}
                style={{
                  right: isMobile ? 16 : CHAT_MINIMAP_WIDTH + 16,
                }}
              >
                <span aria-hidden="true">↓</span>
                <span>{t("Scroll to latest")}</span>
              </button>
            )}
            {isMobile ? null : (
              <ChatMinimap
                messages={messages}
                streamingMessage={streamState.streamingMessage}
                scrollContainer={scrollContainerRef}
                messageRefs={messageRefs}
              />
            )}
          </div>

          <div {...stylex.props(styles.inputRegion)}>
            <div
              style={{
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
                paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
              }}
            >
              <div {...stylex.props(inlineStyles.inline26)}>
                <ExtensionWidgets widgets={belowEditorWidgets} />
              </div>
            </div>
            {chatInputElement}
          </div>
        </>
      )}
    </div>
  )
}
const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
    position: "relative",
  },
  centeredState: {
    alignItems: "center",
    color: "var(--text-muted)",
    display: "flex",
    height: "100%",
    justifyContent: "center",
  },
  error: {
    color: "oklch(70.4% 0.191 22.216)",
  },
  dropZone: {
    alignItems: "center",
    animationDuration: "150ms",
    animationFillMode: "both",
    animationName: dropZoneIn,
    animationTimingFunction: "ease",
    backdropFilter: "blur(1px)",
    backgroundColor: "rgba(37, 99, 235, 0.06)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    pointerEvents: "none",
    position: "absolute",
    zIndex: 50,
  },
  dropRippleLayer: {
    alignItems: "center",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    pointerEvents: "none",
    position: "absolute",
  },
  dropRipple: {
    animationDuration: "2.4s",
    animationFillMode: "backwards",
    animationIterationCount: "infinite",
    animationName: dropRipple,
    animationTimingFunction: "ease-out",
    borderColor: "rgba(37, 99, 235, 0.5)",
    borderRadius: "50%",
    borderStyle: "solid",
    borderWidth: 1.5,
    height: 720,
    position: "absolute",
    width: 720,
  },
  dropIllustration: {
    filter: "drop-shadow(0 6px 18px rgba(37, 99, 235, 0.18))",
  },
  emptySession: {
    alignItems: "center",
    display: "flex",
    flex: 1,
    flexDirection: "column",
    justifyContent: "center",
    overflowY: "auto",
    paddingBlock: 32,
    paddingInline: 16,
  },
  chatColumn: {
    maxWidth: 850,
    width: "100%",
  },
  emptyHeader: {
    marginBottom: 12,
  },
  conversation: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  scroller: {
    flex: 1,
    overflowY: "auto",
    paddingTop: 16,
    scrollbarWidth: "none",
  },
  agentPhase: {
    color: "var(--text-muted)",
    fontSize: 13,
    paddingBlock: 8,
  },
  pulse: {
    animationDuration: "1.5s",
    animationIterationCount: "infinite",
    animationName: pulse,
  },
  inputRegion: {
    position: "relative",
  },
})
function ExtensionStatusBar({ statuses }: { statuses: ReadonlyArray<ExtensionStatusContribution> }) {
  const visibleStatuses = statuses.filter(
    (status) => status._tag === "Text" && status.key !== "weixin" && status.key !== "chrome",
  )
  if (visibleStatuses.length === 0) return null
  return (
    <div {...stylex.props(inlineStyles.inline27)}>
      {visibleStatuses.map((status) => (
        <div key={status.key} {...stylex.props(inlineStyles.inline28)}>
          <span {...stylex.props(inlineStyles.inline29)}>{status.key}</span>
          <span {...stylex.props(inlineStyles.inline30)}>{status._tag === "Text" ? status.text : ""}</span>
        </div>
      ))}
    </div>
  )
}
function ExtensionWidgets({ widgets }: { widgets: ExtensionWidgetItem[] }) {
  if (widgets.length === 0) return null
  return (
    <div {...stylex.props(inlineStyles.inline31)}>
      {widgets.map((widget) => (
        <div key={widget.key} {...stylex.props(inlineStyles.inline32)}>
          <div {...stylex.props(inlineStyles.inline33)}>{widget.key}</div>
          {widget.content.kind === "text" ? (
            <pre {...stylex.props(inlineStyles.inline34)}>{widget.content.lines.join("\n")}</pre>
          ) : (
            <div {...stylex.props(inlineStyles.inline35)}>
              <img
                src={widget.content.dataUrl}
                alt={widget.content.alt}
                width={widget.content.width}
                height={widget.content.height}
                {...stylex.props(inlineStyles.inline36)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
type ExtensionDialogRequest = ExtensionInteraction
function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest
  onRespond: (
    request: ExtensionDialogRequest,
    response:
      | {
          value: string
        }
      | {
          confirmed: boolean
        }
      | {
          cancelled: true
        },
  ) => void
}) {
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "")
  useEffect(() => {
    setValue(request.method === "editor" ? (request.prefill ?? "") : "")
  }, [request])
  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, {
        confirmed: true,
      })
    } else {
      onRespond(request, {
        value,
      })
    }
  }
  return (
    <div {...stylex.props(inlineStyles.inline48)}>
      <div role="dialog" aria-modal="true" {...stylex.props(inlineStyles.inline49)}>
        <div {...stylex.props(inlineStyles.inline50)}>
          <div {...stylex.props(inlineStyles.inline51)}>{request.title}</div>
          <div {...stylex.props(inlineStyles.inline52)}>extension request</div>
        </div>

        <div {...stylex.props(inlineStyles.inline53)}>
          {request.method === "confirm" && <div {...stylex.props(inlineStyles.inline54)}>{request.message}</div>}
          {request.method === "select" && (
            <div {...stylex.props(inlineStyles.inline55)}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() =>
                    onRespond(request, {
                      value: option,
                    })
                  }
                  {...stylex.props(inlineStyles.inline56)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue()
                if (e.key === "Escape")
                  onRespond(request, {
                    cancelled: true,
                  })
              }}
              {...stylex.props(inlineStyles.inline57)}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape")
                  onRespond(request, {
                    cancelled: true,
                  })
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue()
              }}
              {...stylex.props(inlineStyles.inline58)}
            />
          )}
        </div>

        <div {...stylex.props(inlineStyles.inline59)}>
          <button
            onClick={() =>
              onRespond(request, {
                cancelled: true,
              })
            }
            {...stylex.props(inlineStyles.inline60)}
          >
            Cancel
          </button>
          {request.method === "confirm" ? (
            <button onClick={submitValue} {...stylex.props(inlineStyles.inline61)}>
              Confirm
            </button>
          ) : request.method !== "select" ? (
            <button onClick={submitValue} {...stylex.props(inlineStyles.inline62)}>
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
const inlineStyles = stylex.create({
  assistantTurn: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    marginBottom: 25,
  },
  turnMetrics: {
    alignItems: "center",
    display: "flex",
    gap: 8,
    minHeight: 18,
  },
  activityGroup: {
    color: "var(--text-muted)",
    position: "relative",
  },
  activityToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    minHeight: 34,
    padding: "2px 6px 2px 2px",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    ":hover": {
      background: "var(--bg-subtle)",
      color: "var(--text)",
    },
  },
  activityComplete: {
    alignItems: "center",
    background: "rgba(34,197,94,0.12)",
    borderRadius: "50%",
    color: "#16a34a",
    display: "flex",
    flex: "0 0 auto",
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  activityTitle: {
    fontSize: 12,
    fontWeight: 600,
  },
  activityChevron: {
    color: "var(--text-dim)",
    flexShrink: 0,
    marginLeft: 1,
    transition: "transform 0.15s",
  },
  activityBody: {
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    marginLeft: 10,
    padding: "3px 0 3px 20px",
  },
  processStateDot: {
    animationDuration: "800ms",
    animationIterationCount: "infinite",
    animationName: spin,
    animationTimingFunction: "linear",
    border: "2px solid var(--accent)",
    borderRightColor: "transparent",
    borderRadius: "50%",
    flexShrink: 0,
    height: 12,
    margin: 4,
    width: 12,
  },
  inline6: {
    transformOrigin: "center",
  },
  inline7: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
  },
  inline8: {
    fontSize: 14,
    fontWeight: 650,
    color: "var(--text)",
  },
  inline9: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginLeft: 16,
    marginRight: 52,
    fontFamily: "var(--font-mono)",
  },
  inline10: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    minWidth: 0,
    flex: 1,
    lineHeight: 1.4,
    overflow: "hidden",
  },
  inline11: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: 0,
    color: "var(--text)",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  inline12: {
    fontSize: 22,
    color: "var(--text)",
    fontWeight: 700,
    letterSpacing: 0,
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  inline13: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
    flexShrink: 0,
  },
  inline14: {
    fontSize: 11,
    color: "var(--text-muted)",
  },
  inline15: {
    color: "var(--text)",
  },
  inline16: {
    fontSize: 11,
    color: "var(--text-muted)",
  },
  inline17: {
    color: "var(--text)",
  },
  inline20: {
    maxWidth: 850,
    margin: "0 auto",
  },
  inline21: {
    display: "flex",
    justifyContent: "center",
    padding: "4px 0 12px",
  },
  inline22: {
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    padding: "5px 10px",
    fontSize: 11,
  },
  inline23: {
    marginBottom: 16,
  },
  inline24: {
    marginTop: 4,
    marginBottom: 12,
  },
  inline25: {
    position: "absolute",
    bottom: 14,
    zIndex: 45,
    display: "flex",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    padding: "6px 11px",
    border: "1px solid var(--border)",
    borderRadius: 999,
    background: "var(--bg)",
    color: "var(--text)",
    boxShadow: "0 6px 18px rgba(0,0,0,0.14)",
    cursor: "pointer",
    fontSize: 12,
  },
  inline26: {
    maxWidth: 850,
    margin: "0 auto",
  },
  inline27: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 10,
  },
  inline28: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    padding: "4px 8px",
    border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
    borderRadius: 6,
    background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
    color: "var(--text-muted)",
    fontSize: 12,
  },
  inline29: {
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  },
  inline30: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline31: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 10,
  },
  inline32: {
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--bg-panel)",
    overflow: "hidden",
  },
  inline33: {
    padding: "5px 9px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-dim)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  inline34: {
    margin: 0,
    padding: "8px 9px",
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "var(--font-mono)",
  },
  inline35: {
    padding: 12,
    display: "flex",
    justifyContent: "center",
    background: "#fff",
  },
  inline36: {
    display: "block",
    width: "min(100%, 384px)",
    height: "auto",
    imageRendering: "pixelated",
  },
  inline48: {
    position: "absolute",
    inset: 0,
    zIndex: 90,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    background: "rgba(0,0,0,0.18)",
  },
  inline49: {
    width: "min(560px, 100%)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
    overflow: "hidden",
  },
  inline50: {
    padding: "12px 14px",
    borderBottom: "1px solid var(--border)",
  },
  inline51: {
    color: "var(--text)",
    fontSize: 14,
    fontWeight: 650,
  },
  inline52: {
    marginTop: 3,
    color: "var(--text-dim)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  inline53: {
    padding: 14,
  },
  inline54: {
    color: "var(--text-muted)",
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
  },
  inline55: {
    display: "grid",
    gap: 8,
  },
  inline56: {
    width: "100%",
    padding: "9px 10px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
  },
  inline57: {
    width: "100%",
    padding: "9px 10px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    outline: "none",
    fontSize: 13,
  },
  inline58: {
    width: "100%",
    minHeight: 220,
    padding: 10,
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    outline: "none",
    resize: "vertical",
    fontSize: 13,
    lineHeight: 1.55,
    fontFamily: "var(--font-mono)",
  },
  inline59: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "10px 14px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-panel)",
  },
  inline60: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  inline61: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
  },
  inline62: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--accent)",
    background: "var(--accent)",
    color: "#fff",
    cursor: "pointer",
  },
})
