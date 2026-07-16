import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
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
  SessionTreeNode,
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
import { MessageView, TurnUsageSummary } from "./MessageView"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { ChatMinimap, useMessageRefs } from "./ChatMinimap"
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession"
import { useAudio } from "@/hooks/useAudio"
import { useDragDrop } from "@/hooks/useDragDrop"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useI18n } from "@/lib/i18n"
import {
  getChromeStatusProjection,
  getWeixinStatusProjection,
  sameWeixinStatusProjection,
} from "@/lib/extension-status"
import { NOTICE_AUTO_DISMISS_MS, type NoticeItem, type NoticeType } from "@/lib/notices"
import { copyText } from "@/lib/clipboard"
import { runBrowser } from "@/browser/api-client"
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
    tree: SessionTreeNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => void
  onSystemPromptChange?: (prompt: string | null) => void
  onSessionStatsChange?: (stats: SessionStats | null) => void
  onSessionStatsPanelOpen?: () => void
  onContextUsageChange?: (
    usage: { percent: number | null; contextWindow: number; tokens: number | null } | null,
  ) => void
  onWeixinStatusChange?: (status: WeixinStatusProjection) => void
  onOpenFile?: (filePath: string) => void
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
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content }
  if (options.omitUsage) next.usage = undefined
  return next
}

function ProcessDetailsGroup({
  messageCount,
  toolCallCount,
  children,
}: {
  messageCount: number
  toolCallCount: number
  children: ReactNode
}) {
  const { locale, t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const parts = [
    t("Process details"),
    locale === "zh-CN" ? `${messageCount} 条消息` : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
  ]
  if (toolCallCount > 0)
    parts.push(
      locale === "zh-CN"
        ? `${toolCallCount} 次工具调用`
        : `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`,
    )

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={t(expanded ? "Collapse process details" : "Expand process details")}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
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
}: Props) {
  const { t } = useI18n()
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio()
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
    chromePackageLoaded,
    chromeControlEnabled,
    chromeControlPending,
    chromeProfileConnection,
    chromeExtensionId,
    chromeExtensionDirectory,
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
    handleModelChange,
    handleCompact,
    handleSteer,
    handleFollowUp,
    handlePromptWithStreamingBehavior,
    handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange,
    handleChromeControlChange,
    handleLoopControl,
    loopControlPending,
    handleWeixinControl,
    weixinControlPending,
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
    onSystemPromptChange,
    onSessionStatsPanelOpen,
  })

  const sessionBusy = agentRunning || activeBashExecution !== null
  const activeBashOutputLength = activeBashExecution?.output.length

  useEffect(() => {
    if (!loading && inputFocusEpoch > 0) chatInputRef?.current?.focus()
  }, [chatInputRef, inputFocusEpoch, loading])

  useEffect(() => {
    if (activeBashOutputLength === undefined) return
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [activeBashOutputLength, messagesEndRef])

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

  const chromeControlStatus = getChromeStatusProjection(extensionStatuses)

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
      onCompact={handleCompact}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={handleToolPresetChange}
      browserControlEnabled={chromeControlEnabled}
      browserControlPending={chromeControlPending}
      browserControlStatus={chromeControlStatus}
      browserControlProfile={chromeProfileConnection}
      browserControlPackageLoaded={chromePackageLoaded}
      browserControlExtensionId={chromeExtensionId}
      browserControlExtensionDirectory={chromeExtensionDirectory}
      onBrowserControlChange={handleChromeControlChange}
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
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session.id}
      cwd={session.cwd}
    />
  )

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor")
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor")

  if (loading) {
    return <div className="flex h-full items-center justify-center text-text-muted">Loading session...</div>
  }

  if (error) {
    return <div className="flex h-full items-center justify-center text-red-400">{error}</div>
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !agentRunning && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <svg
              width="280"
              height="280"
              viewBox="0 0 140 140"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
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
            <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text)" }}>
              {dragKind === "directory"
                ? t("Use the top-left project picker to select a folder")
                : t("Drop files to attach")}
            </div>
          </div>
        </div>
      )}

      {extensionDialog && <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />}

      {isEmptySession ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  minWidth: 0,
                  flex: 1,
                  lineHeight: 1.4,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    letterSpacing: 0,
                    color: "var(--text)",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  π
                </span>
                <span
                  style={{
                    fontSize: 22,
                    color: "var(--text)",
                    fontWeight: 700,
                    letterSpacing: 0,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Pi Agent Web
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{__APP_VERSION__}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{__PI_VERSION__}</span>
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
          <div className="relative flex flex-1 overflow-hidden">
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 0,
                right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
                zIndex: 40,
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
                pointerEvents: "none",
              }}
            >
              <div style={{ maxWidth: 820, margin: "0 auto" }}>
                <NoticeShelf
                  notices={notices}
                  autoDismissNoticeId={autoDismissNoticeId}
                  onDismiss={dismissNotice}
                  floating
                  align="right"
                />
              </div>
            </div>
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pt-4 [scrollbar-width:none]">
              <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
                <div style={{ maxWidth: 820, margin: "0 auto" }}>
                  <CompanionRendererRegistry
                    statuses={extensionStatuses}
                    sessionId={session.id}
                    sessionBusy={sessionBusy}
                    loopControlPending={loopControlPending}
                    chromeControlPending={chromeControlPending}
                    chromeControlEnabled={chromeControlEnabled}
                    weixinControlPending={weixinControlPending}
                    onLoopControl={handleLoopControl}
                    onChromeControl={handleChromeControlChange}
                    onWeixinControl={handleWeixinControl}
                  />
                  <ExtensionStatusBar statuses={extensionStatuses} />
                  <ExtensionWidgets widgets={aboveEditorWidgets} />

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
                        ;(lastUserMsgRef as { current: HTMLDivElement | null }).current = el
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
                            idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined
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
                      if (isLiveTail) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(
                            renderMessage(renderIdx, { hideUsage: messages[renderIdx].role === "assistant" }),
                          )
                        }
                        idx = endIdx
                        continue
                      }

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
                          ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                          : null
                      const finalAnswerMessage =
                        finalSplit.answerBlocks.length > 0
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
                            toolCallCount={
                              countToolCalls(messages, visibleProcessIndices) +
                              countToolCallBlocks(finalSplit.processBlocks)
                            }
                          >
                            {visibleProcessIndices.map((processIdx) =>
                              renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }),
                            )}
                            {finalProcessMessage &&
                              renderMessage(finalAssistantIdx, {
                                attachRef: false,
                                keyPrefix: "process-final",
                                messageOverride: finalProcessMessage,
                                showTimestamp: false,
                              })}
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
                            messageOverride: finalAnswerMessage,
                            turnUsage: turnUsage ?? undefined,
                          }),
                        )
                      } else if (turnUsage) {
                        rendered.push(
                          <div key={`turn-usage-${userIdx}-${finalAssistantIdx}`} style={{ marginBottom: 16 }}>
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
                    <div className="py-2 text-[13px] text-text-muted">
                      <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
                    </div>
                  )}

                  {runInProgress && liveTurnUsage && (
                    <div style={{ marginTop: 4, marginBottom: 12 }}>
                      <TurnUsageSummary usage={liveTurnUsage} ongoing />
                    </div>
                  )}

                  {agentRunning && (
                    <div
                      style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }}
                    />
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>
            {isMobile ? null : (
              <ChatMinimap
                messages={messages}
                streamingMessage={streamState.streamingMessage}
                scrollContainer={scrollContainerRef}
                messageRefs={messageRefs}
              />
            )}
          </div>

          <div className="relative">
            <div
              style={{
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
                paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
              }}
            >
              <div style={{ maxWidth: 820, margin: "0 auto" }}>
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

function ExtensionStatusBar({ statuses }: { statuses: ReadonlyArray<ExtensionStatusContribution> }) {
  const visibleStatuses = statuses.filter(
    (status) => status._tag === "Text" && status.key !== "weixin" && status.key !== "chrome",
  )
  if (visibleStatuses.length === 0) return null
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {visibleStatuses.map((status) => (
        <div
          key={status.key}
          style={{
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
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{status.key}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status._tag === "Text" ? status.text : ""}
          </span>
        </div>
      ))}
    </div>
  )
}

function ExtensionWidgets({ widgets }: { widgets: ExtensionWidgetItem[] }) {
  if (widgets.length === 0) return null
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "5px 9px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
          >
            {widget.key}
          </div>
          {widget.content.kind === "text" ? (
            <pre
              style={{
                margin: 0,
                padding: "8px 9px",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
              }}
            >
              {widget.content.lines.join("\n")}
            </pre>
          ) : (
            <div style={{ padding: 12, display: "flex", justifyContent: "center", background: "#fff" }}>
              <img
                src={widget.content.dataUrl}
                alt={widget.content.alt}
                width={widget.content.width}
                height={widget.content.height}
                style={{ display: "block", width: "min(100%, 384px)", height: "auto", imageRendering: "pixelated" }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

const NOTICE_VISUALS: Record<NoticeType, { label: string; mark: string; color: string }> = {
  info: { label: "Notice", mark: "i", color: "var(--accent)" },
  success: { label: "Success", mark: "✓", color: "#16a34a" },
  warning: { label: "Warning", mark: "!", color: "#d97706" },
  error: { label: "Error", mark: "×", color: "#dc2626" },
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
      { onSuccess: () => undefined },
    )
  }, [])

  if (notices.length === 0) return null
  return (
    <div
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        gap: 8,
        marginBottom: floating ? 0 : 10,
        pointerEvents: "none",
        width: "100%",
      }}
    >
      {notices.map((notice) => {
        const visual = NOTICE_VISUALS[notice.type]
        const copied = copiedNoticeId === notice.id
        return (
          <section
            key={notice.id}
            className="notice-shelf-item"
            role={notice.type === "error" || notice.type === "warning" ? "alert" : "status"}
            style={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: "28px minmax(0, 1fr) auto",
              alignItems: "start",
              gap: 11,
              width: "min(440px, 100%)",
              overflow: "hidden",
              borderRadius: 13,
              border: `1px solid color-mix(in srgb, ${visual.color} 22%, var(--border))`,
              background: `color-mix(in srgb, var(--bg) 96%, ${visual.color})`,
              color: "var(--text)",
              boxShadow: floating
                ? "0 16px 44px -22px rgba(15,23,42,0.38), 0 3px 10px rgba(15,23,42,0.08)"
                : "0 10px 32px -22px rgba(15,23,42,0.30), 0 2px 8px rgba(15,23,42,0.06)",
              fontSize: 13,
              lineHeight: 1.55,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "12px 11px 11px",
              pointerEvents: "auto",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: `color-mix(in srgb, ${visual.color} 13%, transparent)`,
                color: visual.color,
                fontSize: 15,
                fontWeight: 750,
                lineHeight: 1,
              }}
            >
              {visual.mark}
            </span>

            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 22, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.01em" }}>{t(visual.label)}</span>
                {notice.source === "extension" && (
                  <span
                    style={{
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: "var(--bg-panel)",
                      color: "var(--text-dim)",
                      fontSize: 10,
                      fontWeight: 650,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {t("Extension")}
                  </span>
                )}
              </div>
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  paddingRight: 4,
                  color: "var(--text-muted)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  userSelect: "text",
                }}
              >
                {notice.message}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                type="button"
                className="notice-shelf-action"
                onClick={() => copyNotice(notice)}
                aria-label={t(copied ? "Copied" : "Copy")}
                title={t(copied ? "Copied" : "Copy")}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 28,
                  height: 28,
                  padding: 0,
                  border: "none",
                  borderRadius: 8,
                  background: copied ? "var(--bg-selected)" : "transparent",
                  color: copied ? visual.color : "var(--text-dim)",
                  cursor: "pointer",
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
                className="notice-shelf-action"
                onClick={() => onDismiss(notice.id)}
                aria-label={t("Dismiss")}
                title={t("Dismiss")}
                style={{
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
                }}
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
                style={{ background: visual.color, animationDuration: `${NOTICE_AUTO_DISMISS_MS}ms` }}
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
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => void
}) {
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "")

  useEffect(() => {
    setValue(request.method === "editor" ? (request.prefill ?? "") : "")
  }, [request])

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true })
    } else {
      onRespond(request, { value })
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            extension request
          </div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {request.message}
            </div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
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
                if (e.key === "Escape") onRespond(request, { cancelled: true })
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true })
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue()
              }}
              style={{
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
              }}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Confirm
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
