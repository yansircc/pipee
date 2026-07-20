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
  countToolCallBlocks,
  getDisplayableAssistantBlocks,
  splitFinalAssistantBlocks,
  summarizeTurnUsage,
  type TurnUsage,
} from "@/lib/message-display"
import { MessageView, ProcessMessageView, TurnUsageSummary } from "./MessageView"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { ChatMinimap, useMessageRefs } from "./ChatMinimap"
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession"
import { useAudio } from "@/hooks/useAudio"
import { useDragDrop } from "@/hooks/useDragDrop"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import { getWeixinStatusProjection, sameWeixinStatusProjection } from "@/lib/extension-status"
import { NOTICE_AUTO_DISMISS_MS, type NoticeItem, type NoticeType } from "@/lib/notices"
import { copyText } from "@/lib/clipboard"
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
function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some(
    (block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
  )
}
function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx
  }
  return -1
}
function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0
  for (const idx of indices) {
    const msg = messages[idx]
    if (msg?.role !== "assistant") continue
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage))
  }
  return count
}
function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0
  }
  return message.role === "custom"
}
function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: {
    omitUsage?: boolean
  } = {},
): AssistantMessage {
  const next = {
    ...message,
    content,
  }
  if (options.omitUsage) next.usage = undefined
  return next
}
function ProcessDetailsGroup({
  messageCount,
  toolCallCount,
  running,
  children,
}: {
  messageCount: number
  toolCallCount: number
  running: boolean
  children: ReactNode
}) {
  const { locale, t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const detailParts = [
    locale === "zh-CN" ? `${messageCount} 条消息` : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
  ]
  if (toolCallCount > 0)
    detailParts.push(
      locale === "zh-CN"
        ? `${toolCallCount} 次工具调用`
        : `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`,
    )
  return (
    <div aria-busy={running} {...stylex.props(inlineStyles.inline1)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        {...stylex.props(inlineStyles.inline2)}
        title={t(expanded ? "Collapse process details" : "Expand process details")}
      >
        {running && <span {...stylex.props(inlineStyles.processStateDot)} aria-hidden="true" />}
        <span {...stylex.props(inlineStyles.processSummaryCopy)}>
          <strong {...stylex.props(inlineStyles.processSummaryTitle)}>{t("Process details")}</strong>
          <small {...stylex.props(inlineStyles.processSummaryMeta)}>{detailParts.join(" · ")}</small>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...stylex.props(inlineStyles.inline3)}
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
          }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
      </button>
      {expanded && <div {...stylex.props(inlineStyles.inline5)}>{children}</div>}
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
    notices,
    autoDismissNoticeId,
    dismissNotice,
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
      onAbort={handleAbort}
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
                <span {...stylex.props(inlineStyles.inline12)}>Pi Agent Web</span>
              </div>
              <div {...stylex.props(inlineStyles.inline13)}>
                <span {...stylex.props(inlineStyles.inline14)}>
                  web <span {...stylex.props(inlineStyles.inline15)}>v{__APP_VERSION__}</span>
                </span>
                <span {...stylex.props(inlineStyles.inline16)}>
                  pi <span {...stylex.props(inlineStyles.inline17)}>v{__PI_VERSION__}</span>
                </span>
              </div>
            </div>
            <NoticeShelf
              notices={notices}
              autoDismissNoticeId={autoDismissNoticeId}
              onDismiss={dismissNotice}
              align="right"
            />
            {chatInputElement}
          </div>
        </div>
      ) : (
        <>
          <div {...stylex.props(styles.conversation)}>
            <div
              {...stylex.props(inlineStyles.inline18)}
              style={{
                right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
              }}
            >
              <div {...stylex.props(inlineStyles.inline19)}>
                <NoticeShelf
                  notices={notices}
                  autoDismissNoticeId={autoDismissNoticeId}
                  onDismiss={dismissNotice}
                  floating
                  align="right"
                />
              </div>
            </div>
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
                      const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx)
                      const turnUsage = summarizeTurnUsage(messages, userIdx, endIdx)
                      if (finalAssistantIdx === -1) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(renderMessage(renderIdx))
                        }
                        idx = endIdx
                        continue
                      }
                      const isLiveTail = runInProgress && endIdx === messages.length && userIdx === lastUserIdx
                      rendered.push(renderMessage(userIdx))
                      const processIndices: number[] = []
                      for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                        processIndices.push(processIdx)
                      }
                      const visibleProcessIndices = processIndices.filter((processIdx) =>
                        hasDisplayableProcessMessage(messages[processIdx]),
                      )
                      const finalAssistant = messages[finalAssistantIdx] as AssistantMessage
                      const finalSplit = splitFinalAssistantBlocks(finalAssistant)
                      const finalProcessMessage =
                        finalSplit.processBlocks.length > 0
                          ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, {
                              omitUsage: true,
                            })
                          : null
                      const finalAnswerMessage =
                        finalSplit.answerBlocks.length > 0 ||
                        finalAssistant.stopReason === "aborted" ||
                        Boolean(finalAssistant.errorMessage?.trim())
                          ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                          : null
                      const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0)
                      if (processCount > 0) {
                        const processRefIdx =
                          visibleProcessIndices
                            .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                            .find((value): value is number => typeof value === "number") ??
                          (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx))
                        const processGroup = (
                          <ProcessDetailsGroup
                            messageCount={processCount}
                            running={isLiveTail}
                            toolCallCount={
                              countToolCalls(messages, visibleProcessIndices) +
                              countToolCallBlocks(finalSplit.processBlocks)
                            }
                          >
                            {visibleProcessIndices.map((processIdx) => (
                              <ProcessMessageView
                                key={`process-${processIdx}`}
                                message={messages[processIdx]}
                                toolResults={toolResultsMap}
                                prevTimestamp={
                                  processIdx > 0
                                    ? (
                                        messages[processIdx - 1] as AgentMessage & {
                                          timestamp?: number
                                        }
                                      ).timestamp
                                    : undefined
                                }
                                sessionId={session.id}
                                entryId={entryIds[processIdx]}
                              />
                            ))}
                            {finalProcessMessage && (
                              <ProcessMessageView
                                key={`process-final-${finalAssistantIdx}`}
                                message={finalProcessMessage}
                                toolResults={toolResultsMap}
                                prevTimestamp={
                                  finalAssistantIdx > 0
                                    ? (
                                        messages[finalAssistantIdx - 1] as AgentMessage & {
                                          timestamp?: number
                                        }
                                      ).timestamp
                                    : undefined
                                }
                                sessionId={session.id}
                                entryId={entryIds[finalAssistantIdx]}
                              />
                            )}
                          </ProcessDetailsGroup>
                        )
                        rendered.push(
                          <div
                            key={`process-group-${userIdx}-${finalAssistantIdx}`}
                            ref={
                              processRefIdx === undefined
                                ? undefined
                                : (el) => {
                                    messageRefs.current[processRefIdx] = el
                                  }
                            }
                          >
                            {processGroup}
                          </div>,
                        )
                      }
                      if (finalAnswerMessage) {
                        rendered.push(
                          renderMessage(finalAssistantIdx, {
                            hideUsage: isLiveTail,
                            messageOverride: finalAnswerMessage,
                            turnUsage: isLiveTail ? undefined : (turnUsage ?? undefined),
                          }),
                        )
                      } else if (turnUsage && !isLiveTail) {
                        rendered.push(
                          <div
                            key={`turn-usage-${userIdx}-${finalAssistantIdx}`}
                            {...stylex.props(inlineStyles.inline23)}
                          >
                            <TurnUsageSummary usage={turnUsage} />
                          </div>,
                        )
                      }
                      for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                        rendered.push(renderMessage(renderIdx))
                      }
                      idx = endIdx
                    }
                    return rendered
                  })()}

                  {streamState.isStreaming && streamState.streamingMessage && (
                    <MessageView
                      message={streamState.streamingMessage as AgentMessage}
                      isStreaming
                      modelNames={modelNames}
                      cwd={messageCwd}
                      onOpenFile={onOpenFile}
                    />
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

                  {runInProgress && liveTurnUsage && (
                    <div {...stylex.props(inlineStyles.inline24)}>
                      <TurnUsageSummary usage={liveTurnUsage} ongoing />
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
const NOTICE_VISUALS: Record<
  NoticeType,
  {
    label: string
    mark: string
    color: string
  }
> = {
  info: {
    label: "Notice",
    mark: "i",
    color: "var(--accent)",
  },
  success: {
    label: "Success",
    mark: "✓",
    color: "#16a34a",
  },
  warning: {
    label: "Warning",
    mark: "!",
    color: "#d97706",
  },
  error: {
    label: "Error",
    mark: "×",
    color: "#dc2626",
  },
}
function NoticeShelf({
  notices,
  autoDismissNoticeId,
  onDismiss,
  floating = false,
  align = "left",
}: {
  notices: NoticeItem[]
  autoDismissNoticeId: string | null
  onDismiss: (id: string) => void
  floating?: boolean
  align?: "left" | "right"
}) {
  const { t } = useI18n()
  const [copiedNoticeId, setCopiedNoticeId] = useState<string | null>(null)
  const copyNotice = useCallback((notice: NoticeItem) => {
    runBrowser(
      copyText(notice.message).pipe(
        Effect.tap(() => Effect.sync(() => setCopiedNoticeId(notice.id))),
        Effect.andThen(Effect.sleep("1400 millis")),
        Effect.tap(() => Effect.sync(() => setCopiedNoticeId((current) => (current === notice.id ? null : current)))),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [])
  if (notices.length === 0) return null
  return (
    <div
      aria-live="polite"
      {...stylex.props(inlineStyles.inline37)}
      style={{
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice) => {
        const visual = NOTICE_VISUALS[notice.type]
        const copied = copiedNoticeId === notice.id
        return (
          <section
            key={notice.id}
            className={`${stylex.props(inlineStyles.inline38).className} notice-shelf-item`}
            role={notice.type === "error" || notice.type === "warning" ? "alert" : "status"}
            style={{
              border: `1px solid color-mix(in srgb, ${visual.color} 22%, var(--border))`,
              background: `color-mix(in srgb, var(--bg) 96%, ${visual.color})`,
              boxShadow: floating
                ? "0 16px 44px -22px rgba(15,23,42,0.38), 0 3px 10px rgba(15,23,42,0.08)"
                : "0 10px 32px -22px rgba(15,23,42,0.30), 0 2px 8px rgba(15,23,42,0.06)",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
            }}
          >
            <span
              aria-hidden="true"
              {...stylex.props(inlineStyles.inline39)}
              style={{
                background: `color-mix(in srgb, ${visual.color} 13%, transparent)`,
                color: visual.color,
              }}
            >
              {visual.mark}
            </span>

            <div {...stylex.props(inlineStyles.inline40)}>
              <div {...stylex.props(inlineStyles.inline41)}>
                <span {...stylex.props(inlineStyles.inline42)}>{t(visual.label)}</span>
                {notice.source === "extension" && (
                  <span {...stylex.props(inlineStyles.inline43)}>{t("Extension")}</span>
                )}
              </div>
              <div {...stylex.props(inlineStyles.inline44)}>{notice.message}</div>
            </div>

            <div {...stylex.props(inlineStyles.inline45)}>
              <button
                type="button"
                className={`${stylex.props(inlineStyles.inline46).className} notice-shelf-action`}
                onClick={() => copyNotice(notice)}
                aria-label={t(copied ? "Copied" : "Copy")}
                title={t(copied ? "Copied" : "Copy")}
                style={{
                  background: copied ? "var(--bg-selected)" : "transparent",
                  color: copied ? visual.color : "var(--text-dim)",
                }}
              >
                {copied ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`${stylex.props(inlineStyles.inline47).className} notice-shelf-action`}
                onClick={() => onDismiss(notice.id)}
                aria-label={t("Dismiss")}
                title={t("Dismiss")}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {notice.id === autoDismissNoticeId && (
              <span
                className="notice-shelf-timer"
                aria-hidden="true"
                style={{
                  background: visual.color,
                  animationDuration: `${NOTICE_AUTO_DISMISS_MS}ms`,
                }}
              />
            )}
          </section>
        )
      })}
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
  inline1: {
    marginBottom: 16,
    overflow: "hidden",
    border: "1px solid var(--border)",
    borderRadius: 11,
    background: "var(--bg-panel)",
  },
  inline2: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    width: "100%",
    minHeight: 52,
    padding: "8px 11px",
    border: "none",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
    ":hover": {
      background: "var(--bg-subtle)",
    },
  },
  inline3: {
    flexShrink: 0,
    order: 3,
    transition: "transform 0.15s",
  },
  inline5: {
    borderTop: "1px solid var(--border-soft)",
    padding: "5px 11px 9px 29px",
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
    height: 9,
    width: 9,
  },
  processSummaryCopy: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    minWidth: 0,
    textAlign: "left",
  },
  processSummaryTitle: {
    color: "var(--text)",
    fontSize: 12,
  },
  processSummaryMeta: {
    color: "var(--text-dim)",
    fontSize: 11,
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
  inline18: {
    position: "absolute",
    top: 12,
    left: 0,
    zIndex: 40,
    pointerEvents: "none",
  },
  inline19: {
    maxWidth: 850,
    margin: "0 auto",
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
  inline37: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    pointerEvents: "none",
    width: "100%",
  },
  inline38: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr) auto",
    alignItems: "start",
    gap: 11,
    width: "min(440px, 100%)",
    overflow: "hidden",
    borderRadius: 13,
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1.55,
    transformOrigin: "top center",
    padding: "12px 11px 11px",
    pointerEvents: "auto",
  },
  inline39: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    borderRadius: "50%",
    fontSize: 15,
    fontWeight: 750,
    lineHeight: 1,
  },
  inline40: {
    minWidth: 0,
  },
  inline41: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 22,
    marginBottom: 3,
  },
  inline42: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.01em",
  },
  inline43: {
    padding: "1px 6px",
    borderRadius: 999,
    background: "var(--bg-panel)",
    color: "var(--text-dim)",
    fontSize: 10,
    fontWeight: 650,
    letterSpacing: "0.02em",
  },
  inline44: {
    maxHeight: 260,
    overflowY: "auto",
    paddingRight: 4,
    color: "var(--text-muted)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    userSelect: "text",
  },
  inline45: {
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  inline46: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  inline47: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: "var(--text-dim)",
    cursor: "pointer",
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
