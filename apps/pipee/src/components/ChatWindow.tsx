import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import type { DropPayload } from "@/lib/drop-paths"
import type {
  ExtensionInteraction,
  ExtensionStatusContribution,
  ExtensionWidgetItem,
  SessionInfo,
  SessionStats,
  SessionBranchNode,
  WeixinStatusProjection,
} from "@/api/contract"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { useAgentSession } from "@/hooks/useAgentSession"
import { useAudio } from "@/hooks/useAudio"
import { useDragDrop } from "@/hooks/useDragDrop"
import { useI18n } from "@/lib/i18n"
import { getWeixinStatusProjection, sameWeixinStatusProjection } from "@/lib/extension-status"
import { CompanionRendererRegistry } from "@/features/companions/renderer-registry"
import { compileConversationDocument } from "@/lib/conversation-document"
import type { ConversationDocument } from "@/lib/conversation-document"
import { emptyDisclosureState, type DisclosureState } from "@/lib/disclosure-projection"
import { useAppForm, useFormSelector } from "@/ui/interaction/AppForm"
import { TranscriptViewport } from "./TranscriptViewport"
import { TurnNavigator } from "./TurnNavigator"
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
const CHAT_COLUMN_PADDING = 16
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
    transcriptSources,
    runId,
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
    handleClearQueue,
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
  const [editorDialogOpen, setEditorDialogOpen] = useState(false)
  const previousCancelEpoch = useRef(cancelActivityEpoch)
  useEffect(() => {
    if (cancelActivityEpoch <= previousCancelEpoch.current) return
    previousCancelEpoch.current = cancelActivityEpoch
    handleAbort()
  }, [cancelActivityEpoch, handleAbort])
  useEffect(() => {
    onActivityStateChange?.({ busy: sessionBusy, blockingDialog: editorDialogOpen })
  }, [editorDialogOpen, onActivityStateChange, sessionBusy])
  useEffect(() => () => onActivityStateChange?.({ busy: false, blockingDialog: false }), [onActivityStateChange])
  useEffect(() => {
    if (!loading && inputFocusEpoch > 0) chatInputRef?.current?.focus()
  }, [chatInputRef, inputFocusEpoch, loading])

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
  const previousDocument = useRef<ConversationDocument | undefined>(undefined)
  const document = useMemo(() => {
    const next = compileConversationDocument(
      transcriptSources,
      { liveRunId: agentRunning ? runId : null },
      previousDocument.current,
    )
    previousDocument.current = next
    return next
  }, [agentRunning, runId, transcriptSources])
  const [disclosure, setDisclosure] = useState<DisclosureState>(emptyDisclosureState)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [navigatorRequest, setNavigatorRequest] = useState<{ turnId: string; epoch: number } | null>(null)
  useEffect(() => {
    setDisclosure(emptyDisclosureState())
    setActiveTurnId(null)
    setNavigatorRequest(null)
  }, [session.id])
  const toggleTrace = useCallback((traceId: string) => {
    setDisclosure((current) => {
      const expandedTraceIds = new Set(current.expandedTraceIds)
      if (expandedTraceIds.has(traceId)) expandedTraceIds.delete(traceId)
      else expandedTraceIds.add(traceId)
      return { ...current, expandedTraceIds }
    })
  }, [])
  const toggleExtension = useCallback((id: string) => {
    setDisclosure((current) => {
      const expandedExtensionIds = new Set(current.expandedExtensionIds)
      if (expandedExtensionIds.has(id)) expandedExtensionIds.delete(id)
      else expandedExtensionIds.add(id)
      return { ...current, expandedExtensionIds }
    })
  }, [])
  const toggleTelemetry = useCallback((turnId: string, expanded: boolean) => {
    setDisclosure((current) => {
      if (current.expandedTelemetryTurnIds.has(turnId) === expanded) return current
      const expandedTelemetryTurnIds = new Set(current.expandedTelemetryTurnIds)
      if (expanded) expandedTelemetryTurnIds.add(turnId)
      else expandedTelemetryTurnIds.delete(turnId)
      return { ...current, expandedTelemetryTurnIds }
    })
  }, [])
  const isEmptySession = document.nodes.length === 0 && !sessionBusy
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
      sendDisabled={extensionDialog !== null}
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
      onClearQueue={handleClearQueue}
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
            <ExtensionWidgets widgets={aboveEditorWidgets} />
            {extensionDialog && (
              <InteractionDock
                request={extensionDialog}
                onRespond={respondToExtensionUi}
                onEditorOpenChange={setEditorDialogOpen}
              />
            )}
            {chatInputElement}
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
      ) : (
        <>
          <div className="companion-region">
            <CompanionRendererRegistry statuses={extensionStatuses} sessionId={session.id} />
            <ExtensionStatusBar statuses={extensionStatuses} />
          </div>
          <div {...stylex.props(styles.conversation)}>
            <TranscriptViewport
              sessionId={session.id}
              document={document}
              disclosure={disclosure}
              cwd={messageCwd}
              modelNames={modelNames}
              sessionBusy={sessionBusy}
              forkingEntryId={forkingEntryId}
              hasMoreBefore={hasMoreBefore}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={loadEarlier}
              onOpenFile={onOpenFile}
              onFork={handleFork}
              onNavigate={handleNavigate}
              onEditContent={(content) => chatInputRef?.current?.insertIfEmpty(content)}
              onToggleTrace={toggleTrace}
              onToggleExtension={toggleExtension}
              onToggleTelemetry={toggleTelemetry}
              onActiveTurnChange={setActiveTurnId}
              navigatorRequest={navigatorRequest}
            />
            <TurnNavigator
              document={document}
              activeTurnId={activeTurnId}
              onNavigate={(turnId) => setNavigatorRequest((current) => ({ turnId, epoch: (current?.epoch ?? 0) + 1 }))}
            />
          </div>

          <div {...stylex.props(styles.inputRegion)}>
            <div
              style={{
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
              }}
            >
              <div {...stylex.props(inlineStyles.inline26)}>
                <ExtensionWidgets widgets={aboveEditorWidgets} />
              </div>
            </div>
            {extensionDialog && (
              <InteractionDock
                request={extensionDialog}
                onRespond={respondToExtensionUi}
                onEditorOpenChange={setEditorDialogOpen}
              />
            )}
            {chatInputElement}
            <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
              <div {...stylex.props(inlineStyles.inline26)}>
                <ExtensionWidgets widgets={belowEditorWidgets} />
              </div>
            </div>
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
type InteractionRequest = ExtensionInteraction
type InteractionResponse = { value: string } | { confirmed: boolean } | { cancelled: true }

function InteractionDock({
  request,
  onRespond,
  onEditorOpenChange,
}: {
  request: InteractionRequest
  onRespond: (request: InteractionRequest, response: InteractionResponse) => void
  onEditorOpenChange: (open: boolean) => void
}) {
  const [editorOpen, setEditorOpen] = useState(false)
  const responded = useRef(false)
  const editorPrefill = request.method === "editor" ? request.prefill : undefined
  const setOpen = useCallback(
    (open: boolean) => {
      setEditorOpen(open)
      onEditorOpenChange(open)
    },
    [onEditorOpenChange],
  )
  const respond = useCallback(
    (response: InteractionResponse) => {
      if (responded.current) return
      responded.current = true
      setOpen(false)
      onRespond(request, response)
    },
    [onRespond, request, setOpen],
  )
  const form = useAppForm({
    defaultValues: { value: editorPrefill ?? "" },
    onSubmitMeta: { selection: null as string | null },
    onSubmit: ({ value, meta }) => {
      if (request.method === "confirm") respond({ confirmed: true })
      else respond({ value: meta.selection ?? value.value })
    },
  })
  const value = useFormSelector(form.store, (state) => state.values.value)
  useEffect(() => {
    form.reset({ value: editorPrefill ?? "" }, { keepDefaultValues: true })
    setEditorOpen(false)
    responded.current = false
    onEditorOpenChange(false)
  }, [editorPrefill, form, onEditorOpenChange, request.interactionId])
  useEffect(() => () => onEditorOpenChange(false), [onEditorOpenChange])
  return (
    <>
      <section
        className="interaction-dock"
        aria-label="Extension interaction"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          respond({ cancelled: true })
        }}
      >
        <div className="interaction-dock-copy">
          <strong>{request.title}</strong>
          {request.method === "confirm" && <span>{request.message}</span>}
          {request.method === "editor" && (
            <span>
              {value.trim()
                ? `${value.trim().slice(0, 120)}${value.trim().length > 120 ? "…" : ""}`
                : "Open the editor to respond"}
            </span>
          )}
        </div>
        {request.method === "select" && (
          <div className="interaction-options">
            {request.options.map((option) => (
              <button key={option} type="button" onClick={() => void form.handleSubmit({ selection: option })}>
                {option}
              </button>
            ))}
          </div>
        )}
        {request.method === "input" && (
          <form
            className="interaction-input"
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.Field name="value">
              {(field) => (
                <input
                  autoFocus
                  value={field.state.value}
                  placeholder={request.placeholder}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </form.Field>
            <button type="submit">Submit</button>
          </form>
        )}
        <div className="interaction-actions">
          <button type="button" onClick={() => respond({ cancelled: true })}>
            Cancel
          </button>
          {request.method === "confirm" && (
            <button type="button" onClick={() => void form.handleSubmit()}>
              Confirm
            </button>
          )}
          {request.method === "editor" && (
            <button type="button" onClick={() => setOpen(true)}>
              Open editor
            </button>
          )}
        </div>
      </section>
      {request.method === "editor" && editorOpen && (
        <div {...stylex.props(inlineStyles.inline48)} onKeyDown={(event) => event.stopPropagation()}>
          <div role="dialog" aria-modal="true" aria-label={request.title} {...stylex.props(inlineStyles.inline49)}>
            <div {...stylex.props(inlineStyles.inline50)}>
              <div {...stylex.props(inlineStyles.inline51)}>{request.title}</div>
            </div>
            <form.Field name="value">
              {(field) => (
                <textarea
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen(false)
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void form.handleSubmit()
                    }
                  }}
                  {...stylex.props(inlineStyles.inline58)}
                />
              )}
            </form.Field>
            <div {...stylex.props(inlineStyles.inline59)}>
              <button type="button" onClick={() => setOpen(false)} {...stylex.props(inlineStyles.inline60)}>
                Close
              </button>
              <button type="button" onClick={() => void form.handleSubmit()} {...stylex.props(inlineStyles.inline62)}>
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
const inlineStyles = stylex.create({
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
