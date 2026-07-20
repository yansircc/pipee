import * as stylex from "@stylexjs/stylex"
import { Fragment, useState, useRef, useEffect, useMemo } from "react"
import { Clock, DateTime, Effect, Option } from "effect"
import { MarkdownBody } from "./MarkdownBody"
import { copyText } from "@/lib/clipboard"
import { parseCompactionSummary } from "@/lib/compaction-summary"
import { elapsedDuration, formatDuration } from "@/lib/duration"
import { isEmptyThinkingBlock, type TurnUsage } from "@/lib/message-display"
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch"
import { useI18n } from "@/lib/i18n"
import { withApi, runApi, runBrowser } from "@/browser/api-client"
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  JsonValue,
} from "@/api/contract"
const MAX_THINKING_CACHE_ENTRIES = 100
const thinkingContentCache = new Map<string, string>()
function loadThinkingContent(
  sessionId: string,
  entryId: string,
  blockIndex: number,
  callbacks: {
    readonly onSuccess: (thinking: string) => void
    readonly onFailure: (error: unknown) => void
  },
) {
  const key = `${sessionId}:${entryId}:${blockIndex}`
  const cached = thinkingContentCache.get(key)
  if (cached !== undefined) {
    thinkingContentCache.delete(key)
    thinkingContentCache.set(key, cached)
    callbacks.onSuccess(cached)
    return () => undefined
  }
  return runApi(
    withApi((api) =>
      api.sessions.thinking({
        params: {
          id: sessionId,
        },
        query: {
          entryId,
          blockIndex,
        },
      }),
    ),
    {
      onSuccess: ({ thinking }) => {
        thinkingContentCache.set(key, thinking)
        if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
          const oldestKey = thinkingContentCache.keys().next().value
          if (oldestKey) thinkingContentCache.delete(oldestKey)
        }
        callbacks.onSuccess(thinking)
      },
      onFailure: callbacks.onFailure,
    },
  )
}
function useThinkingDisclosure(
  block: ThinkingContent,
  sessionId: string | undefined,
  entryId: string | undefined,
  blockIndex: number,
) {
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = () => {
    const nextExpanded = !expanded
    setExpanded(nextExpanded)
    if (!nextExpanded || !block.deferred || content !== null) return
    if (!sessionId || !entryId) {
      setError("Thinking content unavailable")
      return
    }
    setLoading(true)
    setError(null)
    loadThinkingContent(sessionId, entryId, blockIndex, {
      onSuccess: (thinking) => {
        setContent(thinking)
        setLoading(false)
      },
      onFailure: (failure) => {
        setError(failure instanceof Error ? failure.message : String(failure))
        setLoading(false)
      },
    })
  }
  return {
    content,
    detail: loading ? "Loading thinking..." : (error ?? (block.deferred ? content : block.thinking)),
    error,
    expanded,
    toggle,
  }
}
interface Props {
  message: AgentMessage
  isStreaming?: boolean
  toolResults?: Map<string, ToolResultMessage>
  modelNames?: Record<string, string>
  cwd?: string
  onOpenFile?: (filePath: string) => void
  entryId?: string
  onFork?: (entryId: string) => void
  forking?: boolean
  onNavigate?: (entryId: string) => void
  prevAssistantEntryId?: string
  onEditContent?: (content: string) => void
  showTimestamp?: boolean
  prevTimestamp?: number
  sessionId?: string
  turnUsage?: TurnUsage
  hideUsage?: boolean
  turnSegment?: boolean
}
function formatTime(ts?: number): string | null {
  if (!ts) return null
  const date = DateTime.make(ts)
  return Option.match(date, {
    onNone: () => null,
    onSome: (value) =>
      DateTime.formatLocal(value, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
  })
}
function formatClockTime(ts?: number): string | null {
  if (!ts) return null
  const date = DateTime.make(ts)
  return Option.match(date, {
    onNone: () => null,
    onSome: (value) => DateTime.formatLocal(value, { hour: "2-digit", minute: "2-digit" }),
  })
}
export function MessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  entryId,
  onFork,
  forking,
  onNavigate,
  prevAssistantEntryId,
  onEditContent,
  showTimestamp,
  prevTimestamp,
  sessionId,
  turnUsage,
  hideUsage,
  turnSegment,
}: Props) {
  if (message.role === "user") {
    return (
      <UserMessageView
        message={message as UserMessage}
        cwd={cwd}
        onOpenFile={onOpenFile}
        entryId={entryId}
        onFork={onFork}
        forking={forking}
        onNavigate={onNavigate}
        prevAssistantEntryId={prevAssistantEntryId}
        onEditContent={onEditContent}
      />
    )
  }
  if (message.role === "assistant") {
    return (
      <AssistantMessageView
        message={message as AssistantMessage}
        isStreaming={isStreaming}
        toolResults={toolResults}
        modelNames={modelNames}
        cwd={cwd}
        onOpenFile={onOpenFile}
        showTimestamp={showTimestamp}
        prevTimestamp={prevTimestamp}
        sessionId={sessionId}
        entryId={entryId}
        turnUsage={turnUsage}
        hideUsage={hideUsage}
        turnSegment={turnSegment}
      />
    )
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null
  }
  if (message.role === "bashExecution") {
    return <BashExecutionMessageView message={message as BashExecutionMessage} running={isStreaming} />
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />
  }
  return null
}
export function ProcessMessageView({
  message,
  toolResults,
  prevTimestamp,
  sessionId,
  entryId,
}: {
  message: AgentMessage
  toolResults?: Map<string, ToolResultMessage>
  prevTimestamp?: number
  sessionId?: string
  entryId?: string
}) {
  if (message.role === "assistant") {
    const assistant = message as AssistantMessage
    return (
      <>
        {(assistant.content ?? []).map((block, blockIndex) => {
          if (block.type === "thinking" && !block.deferred && block.thinking.trim() === "") return null
          if (block.type === "thinking") {
            return (
              <CompactThinkingRow
                key={`${entryId ?? "process"}-${blockIndex}`}
                block={block as ThinkingContent}
                duration={elapsedSeconds(prevTimestamp, assistant.timestamp)}
                sessionId={sessionId}
                entryId={entryId}
                blockIndex={blockIndex}
              />
            )
          }
          if (block.type === "toolCall") {
            const toolCall = block as ToolCallContent
            const result = toolResults?.get(toolCall.toolCallId)
            return (
              <CompactToolCallRow
                key={`${entryId ?? "process"}-${blockIndex}`}
                block={toolCall}
                result={result}
                duration={elapsedSeconds(assistant.timestamp, result?.timestamp)}
              />
            )
          }
          return null
        })}
      </>
    )
  }
  if (message.role === "custom") {
    const custom = message as CustomMessage
    return <CompactProcessTextRow label={formatCustomType(custom.customType)} text={getMessageText(custom.content)} />
  }
  return null
}

function elapsedSeconds(start?: number, end?: number): number | undefined {
  if (start === undefined || end === undefined) return undefined
  const seconds = Math.round((end - start) / 1000)
  return seconds > 0 ? seconds : undefined
}

function CompactProcessRow({
  label,
  preview,
  duration,
  isError = false,
  running = false,
  expanded,
  onToggle,
  children,
}: {
  label: string
  preview: string
  duration?: number
  isError?: boolean
  running?: boolean
  expanded?: boolean
  onToggle?: () => void
  children?: React.ReactNode
}) {
  const rowContent = (
    <>
      <span
        {...stylex.props(inlineStyles.processRowState)}
        style={{
          background: isError ? "rgba(248,113,113,0.12)" : running ? "var(--accent-soft)" : "rgba(34,197,94,0.12)",
          color: isError ? "#f87171" : running ? "var(--accent)" : "#16a34a",
        }}
        aria-hidden="true"
      >
        {running ? (
          <i {...stylex.props(inlineStyles.processRowRunningDot)} />
        ) : (
          <svg
            width="9"
            height="9"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isError ? <path d="M3 3l6 6m0-6L3 9" /> : <polyline points="2.5 6 5 8.5 9.5 3.5" />}
          </svg>
        )}
      </span>
      <span {...stylex.props(inlineStyles.processRowCopy)}>
        <strong
          {...stylex.props(inlineStyles.processRowLabel)}
          style={{ color: isError ? "#f87171" : running ? "var(--accent)" : "#16a34a" }}
        >
          {label}
        </strong>
        <code {...stylex.props(inlineStyles.processRowPreview)}>{preview}</code>
      </span>
      {duration !== undefined && <time {...stylex.props(inlineStyles.processRowDuration)}>{duration}s</time>}
      {onToggle && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...stylex.props(inlineStyles.processRowChevron)}
          style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          aria-hidden="true"
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      )}
    </>
  )
  return (
    <div className="compact-process-row">
      <div {...stylex.props(inlineStyles.processRow)}>
        {onToggle ? (
          <button type="button" onClick={onToggle} {...stylex.props(inlineStyles.processRowButton)}>
            {rowContent}
          </button>
        ) : (
          <div {...stylex.props(inlineStyles.processRowButton)}>{rowContent}</div>
        )}
        {expanded && children}
      </div>
    </div>
  )
}

function CompactThinkingRow({
  block,
  duration,
  sessionId,
  entryId,
  blockIndex,
}: {
  block: ThinkingContent
  duration?: number
  sessionId?: string
  entryId?: string
  blockIndex: number
}) {
  const { t } = useI18n()
  const disclosure = useThinkingDisclosure(block, sessionId, entryId, blockIndex)
  return (
    <CompactProcessRow
      label={t("Thinking")}
      preview={previewText(block.deferred ? (disclosure.content ?? "Deferred reasoning") : block.thinking)}
      duration={duration}
      expanded={disclosure.expanded}
      onToggle={disclosure.toggle}
    >
      <pre {...stylex.props(inlineStyles.processRowDetails)}>{disclosure.detail}</pre>
    </CompactProcessRow>
  )
}

function CompactToolCallRow({
  block,
  result,
  duration,
}: {
  block: ToolCallContent
  result?: ToolResultMessage
  duration?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isError = result?.isError ?? false
  const resultText = getToolResultText(result) ?? ""
  return (
    <CompactProcessRow
      label={block.toolName}
      preview={getToolPreview(block) || (result ? previewText(resultText) : "Waiting for tool result…")}
      duration={duration}
      isError={isError}
      running={!result}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <div {...stylex.props(inlineStyles.processRowDetailsStack)}>
        <pre {...stylex.props(inlineStyles.processRowDetails)}>{JSON.stringify(block.input, null, 2)}</pre>
        {result && <pre {...stylex.props(inlineStyles.processRowDetails)}>{resultText || "(no output)"}</pre>}
      </div>
    </CompactProcessRow>
  )
}

function CompactProcessTextRow({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false)
  const normalized = text.trim()
  return (
    <CompactProcessRow
      label={label}
      preview={previewText(normalized || "(no message)")}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <pre {...stylex.props(inlineStyles.processRowDetails)}>{normalized || "(no message)"}</pre>
    </CompactProcessRow>
  )
}
function BashExecutionMessageView({ message, running = false }: { message: BashExecutionMessage; running?: boolean }) {
  const { t } = useI18n()
  const status = running
    ? t("Running…")
    : message.cancelled
      ? t("Cancelled")
      : t("Exit code {code}", {
          code: message.exitCode ?? "—",
        })
  return (
    <div {...stylex.props(inlineStyles.inline1)}>
      <div {...stylex.props(inlineStyles.inline2)}>
        <div {...stylex.props(inlineStyles.inline3)}>
          <span {...stylex.props(inlineStyles.inline4)}>$</span>
          <code {...stylex.props(inlineStyles.inline5)}>{message.command}</code>
          <span {...stylex.props(inlineStyles.inline6)}>{status}</span>
        </div>
        <pre {...stylex.props(inlineStyles.inline7)}>
          {message.output || (running ? t("Running…") : t("No output"))}
        </pre>
        <div {...stylex.props(inlineStyles.inline8)}>
          <span>{message.excludeFromContext ? t("Excluded from context") : t("Included in context")}</span>
          {message.truncated && <span>· {t("Output truncated")}</span>}
          {message.fullOutputPath && <code {...stylex.props(inlineStyles.inline9)}>{message.fullOutputPath}</code>}
        </div>
      </div>
    </div>
  )
}
function UserMessageView({
  message,
  cwd,
  onOpenFile,
  entryId,
  onFork,
  forking,
  onNavigate,
  prevAssistantEntryId,
  onEditContent,
}: {
  message: UserMessage
  cwd?: string
  onOpenFile?: (filePath: string) => void
  entryId?: string
  onFork?: (entryId: string) => void
  forking?: boolean
  onNavigate?: (entryId: string) => void
  prevAssistantEntryId?: string
  onEditContent?: (content: string) => void
}) {
  const { t } = useI18n()
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n")
  const imageBlocks: ImageContent[] =
    typeof message.content === "string" ? [] : message.content.filter((b): b is ImageContent => b.type === "image")
  const canFork = !!entryId && !!onFork
  const canNavigate = !!prevAssistantEntryId && !!onNavigate
  const copyContent = () => {
    runBrowser(
      copyText(content).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }
  return (
    <div
      {...stylex.props(inlineStyles.inline10)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div {...stylex.props(inlineStyles.inline11)}>
        <div {...stylex.props(inlineStyles.inline12)}>
          {imageBlocks.length > 0 && (
            <div
              {...stylex.props(inlineStyles.inline13)}
              style={{
                marginBottom: content ? 8 : 0,
              }}
            >
              {imageBlocks.map((img, i) => {
                const src =
                  img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url
                return <img key={i} src={src} alt="" {...stylex.props(inlineStyles.inline14)} />
              })}
            </div>
          )}
          {content && (
            <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>
              {content}
            </MarkdownBody>
          )}
        </div>
      </div>

      {/* Bottom row: action buttons + timestamp */}
      <div {...stylex.props(inlineStyles.inline15)}>
        <div
          {...stylex.props(inlineStyles.inline16)}
          style={{
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
          }}
        >
          <button
            onClick={copyContent}
            title={t("Copy message")}
            {...stylex.props(inlineStyles.inline17)}
            style={{
              color: copied ? "var(--accent)" : "var(--text-dim)",
            }}
            onMouseEnter={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--accent)"
            }}
            onMouseLeave={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--text-dim)"
            }}
          >
            {copied ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {(canFork || canNavigate) && (
          <div
            {...stylex.props(inlineStyles.inline18)}
            style={{
              opacity: hovered || forking ? 1 : 0,
              pointerEvents: hovered || forking ? "auto" : "none",
            }}
          >
            {canNavigate && (
              <button
                onClick={() => {
                  onNavigate!(prevAssistantEntryId!)
                  onEditContent?.(content)
                }}
                title={t("Edit from here — branches within this session")}
                {...stylex.props(inlineStyles.inline19)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-dim)"
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 10 20 15 15 20" />
                  <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                </svg>
                {t("Edit from here")}
              </button>
            )}
            {canFork && (
              <button
                onClick={() => {
                  onFork!(entryId!)
                }}
                disabled={forking}
                title={forking ? "Creating new session…" : "New session — creates an independent copy from here"}
                {...stylex.props(inlineStyles.inline20)}
                style={{
                  color: forking ? "var(--accent)" : "var(--text-dim)",
                  cursor: forking ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!forking) e.currentTarget.style.color = "var(--accent)"
                }}
                onMouseLeave={(e) => {
                  if (!forking) e.currentTarget.style.color = "var(--text-dim)"
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {forking ? "Creating…" : "New session"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  turnUsage,
  hideUsage,
  turnSegment,
}: {
  message: AssistantMessage
  isStreaming?: boolean
  toolResults?: Map<string, ToolResultMessage>
  modelNames?: Record<string, string>
  cwd?: string
  onOpenFile?: (filePath: string) => void
  showTimestamp?: boolean
  prevTimestamp?: number
  sessionId?: string
  entryId?: string
  turnUsage?: TurnUsage
  hideUsage?: boolean
  turnSegment?: boolean
}) {
  const { t } = useI18n()
  const time = showTimestamp ? formatTime(message.timestamp) : null
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({
      block,
      originalIndex,
    }))
    .filter(
      ({ block }) =>
        !isEmptyThinkingBlock(block, {
          isStreaming,
        }),
    )
  const blocks = blockItems.map(({ block }) => block)
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const blockItemsRef = useRef(blockItems)
  blockItemsRef.current = blockItems

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map())
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map())

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    return elapsedSeconds(prevTimestamp, message.timestamp)
  }, [message.timestamp, prevTimestamp])

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()
    if (!toolResults || !message.timestamp) return map
    for (const [callId, result] of toolResults) {
      const seconds = elapsedSeconds(message.timestamp, result.timestamp)
      if (seconds !== undefined) map.set(callId, seconds)
    }
    return map
  }, [toolResults, message.timestamp])
  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
  const termination =
    message.stopReason === "aborted"
      ? {
          label: t("Cancelled"),
          message: undefined,
          error: false,
        }
      : message.errorMessage?.trim()
        ? {
            label: t("Error"),
            message: message.errorMessage.trim(),
            error: true,
          }
        : undefined
  const copyContent = () => {
    runBrowser(
      copyText(textContent).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }
  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      return runApi(Clock.currentTimeMillis, {
        onSuccess: (now) =>
          setStreamingDurations((prev: Map<number, number>) => {
            const next = new Map(prev)
            for (const [idx, start] of blockStartTimesRef.current) {
              if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000))
            }
            return next
          }),
      })
    }
    const tick = (now: number) => {
      const items = blockItemsRef.current

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now)
      })

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false
        const next = new Map(prev)
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex
          const nextOriginalIndex = items[i + 1].originalIndex
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now
            next.set(originalIndex, Math.round((nextStart - start) / 1000))
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
    return runApi(
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Effect.sync(() => tick(now))),
        Effect.andThen(Effect.sleep("300 millis")),
        Effect.forever,
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [isStreaming])
  if (blocks.length === 0 && termination === undefined && !isStreaming) return null
  return (
    <div
      {...stylex.props(inlineStyles.inline22)}
      style={{ marginBottom: turnSegment ? 0 : undefined }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div {...stylex.props(inlineStyles.inline27)}>
        {termination !== undefined && (
          <div
            role={termination.error ? "alert" : "status"}
            {...stylex.props(inlineStyles.inline28)}
            style={{
              border: termination.error ? "1px solid rgba(220, 38, 38, 0.35)" : "1px solid var(--border)",
              background: termination.error ? "rgba(220, 38, 38, 0.08)" : "var(--bg-panel)",
              color: termination.error ? "#dc2626" : "var(--text-muted)",
            }}
          >
            {termination.label}
            {termination.message === undefined ? "" : `: ${termination.message}`}
          </div>
        )}
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView
            key={`${entryId ?? "stream"}-${originalIndex}`}
            block={block}
            toolResults={toolResults}
            isStreaming={isStreaming}
            streamingDuration={
              streamingDurations.get(originalIndex) ??
              (block.type === "thinking" ? thinkingDurationFromFile : undefined)
            }
            toolCallDurations={toolCallDurations}
            cwd={cwd}
            onOpenFile={onOpenFile}
            sessionId={sessionId}
            entryId={entryId}
            blockIndex={originalIndex}
          />
        ))}
      </div>

      <div {...stylex.props(inlineStyles.inline29)}>
        {turnUsage && !isStreaming ? (
          <TurnUsageSummary modelNames={modelNames} usage={turnUsage} />
        ) : message.usage && !isStreaming && !hideUsage ? (
          <div {...stylex.props(inlineStyles.inline30)}>
            {formatUsage(message.usage, elapsedDuration(prevTimestamp, message.timestamp))}
          </div>
        ) : null}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title={t("Copy message")}
            {...stylex.props(inlineStyles.inline31)}
            style={{
              color: copied ? "var(--accent)" : "var(--text-dim)",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
            }}
            onMouseEnter={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--accent)"
            }}
            onMouseLeave={(e) => {
              if (!copied) e.currentTarget.style.color = "var(--text-dim)"
            }}
          >
            {copied ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {time && !isStreaming && <span {...stylex.props(inlineStyles.inline32)}>{time}</span>}
      </div>
    </div>
  )
}
function BlockView({
  block,
  toolResults,
  isStreaming,
  streamingDuration,
  toolCallDurations,
  cwd,
  onOpenFile,
  sessionId,
  entryId,
  blockIndex,
}: {
  block: AssistantContentBlock
  toolResults?: Map<string, ToolResultMessage>
  isStreaming?: boolean
  streamingDuration?: number
  toolCallDurations?: Map<string, number>
  cwd?: string
  onOpenFile?: (filePath: string) => void
  sessionId?: string
  entryId?: string
  blockIndex: number
}) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />
  }
  if (block.type === "thinking") {
    return (
      <ThinkingBlock
        block={block as ThinkingContent}
        duration={streamingDuration}
        sessionId={sessionId}
        entryId={entryId}
        blockIndex={blockIndex}
      />
    )
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent
    const result = toolResults?.get(tc.toolCallId)
    const duration = toolCallDurations?.get(tc.toolCallId)
    return <ToolCallBlock block={tc} result={result} duration={duration} />
  }
  return null
}
function TextBlock({
  block,
  isStreaming,
  cwd,
  onOpenFile,
}: {
  block: TextContent
  isStreaming?: boolean
  cwd?: string
  onOpenFile?: (filePath: string) => void
}) {
  return (
    <MarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>
      {block.text}
    </MarkdownBody>
  )
}
function ThinkingBlock({
  block,
  duration,
  sessionId,
  entryId,
  blockIndex,
}: {
  block: ThinkingContent
  duration?: number
  sessionId?: string
  entryId?: string
  blockIndex: number
}) {
  const { t } = useI18n()
  const disclosure = useThinkingDisclosure(block, sessionId, entryId, blockIndex)
  return (
    <div {...stylex.props(inlineStyles.inline33)}>
      <button onClick={disclosure.toggle} {...stylex.props(inlineStyles.inline34)}>
        <span>{t("Thinking")}</span>
        {duration !== undefined && <span {...stylex.props(inlineStyles.inline35)}>{duration}s</span>}
      </button>
      {disclosure.expanded && (
        <div
          {...stylex.props(inlineStyles.inline36)}
          style={{
            color: disclosure.error ? "#f87171" : "var(--text-muted)",
          }}
        >
          {disclosure.detail}
        </div>
      )}
    </div>
  )
}
function ToolCallBlock({
  block,
  result,
  duration,
}: {
  block: ToolCallContent
  result?: ToolResultMessage
  duration?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const inputStr = JSON.stringify(block.input, null, 2)
  const isEditTool = isEditToolName(block.toolName)
  const resultDiff = result && !result.isError ? getResultDiff(result) : null

  // Result display
  const resultText = getToolResultText(result)
  const resultIsEmpty = resultText === null ? false : resultText.trim() === "(no output)" || resultText.trim() === ""
  const isError = result?.isError ?? false
  return (
    <div
      {...stylex.props(inlineStyles.inline37)}
      style={{
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button onClick={() => setExpanded((v) => !v)} {...stylex.props(inlineStyles.inline38)}>
        <span
          {...stylex.props(inlineStyles.inline39)}
          style={{
            color: isError ? "#f87171" : "#16a34a",
          }}
        >
          {block.toolName}
        </span>
        <span {...stylex.props(inlineStyles.inline40)}>{getToolPreview(block)}</span>
        {duration !== undefined && <span {...stylex.props(inlineStyles.inline41)}>{duration}s</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--text-dim)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...stylex.props(inlineStyles.inline42)}
          style={{
            transform: expanded ? "rotate(180deg)" : "none",
          }}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && !isEditTool && (
        <pre
          {...stylex.props(inlineStyles.inline43)}
          style={{
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded &&
        result &&
        (resultDiff ? (
          <PairedDiffResult diff={resultDiff} />
        ) : (
          <PairedResult text={resultText ?? ""} isEmpty={resultIsEmpty} isError={isError} />
        ))}
    </div>
  )
}
interface ResultDiff {
  text: string
}
function PairedDiffResult({ diff }: { diff: ResultDiff }) {
  return (
    <div {...stylex.props(inlineStyles.inline44)}>
      <SplitPatchView text={diff.text} />
    </div>
  )
}
function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text])
  if (!files) return <PatchTextView text={text} />
  const showFileHeaders = files.length > 1
  return (
    <div {...stylex.props(inlineStyles.inline45)}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          {...stylex.props(inlineStyles.inline46)}
          style={{
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
          }}
        >
          {showFileHeaders && (
            <div {...stylex.props(inlineStyles.inline47)}>
              <SplitDiffHeader title={file.oldPath || "Before"} side="left" />
              <SplitDiffHeader title={file.newPath || "After"} side="right" />
            </div>
          )}

          <div {...stylex.props(inlineStyles.inline48)}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null
              }
              return (
                <div key={rowIndex} {...stylex.props(inlineStyles.inline49)}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      {...stylex.props(inlineStyles.inline50)}
      style={{
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      {title}
    </div>
  )
}
function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
        ? "rgba(248,113,113,0.13)"
        : cell.type === "empty"
          ? "var(--bg-subtle)"
          : "transparent"
  const marker = cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " "
  const markerColor = cell.type === "added" ? "#22c55e" : cell.type === "removed" ? "#f87171" : "var(--text-dim)"
  return (
    <div
      {...stylex.props(inlineStyles.inline51)}
      style={{
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span {...stylex.props(inlineStyles.inline52)}>{cell.lineNo ?? ""}</span>
      <span
        {...stylex.props(inlineStyles.inline53)}
        style={{
          color: markerColor,
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
        }}
      >
        {marker}
      </span>
      <span
        {...stylex.props(inlineStyles.inline54)}
        style={{
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  )
}
function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  return (
    <div {...stylex.props(inlineStyles.inline55)}>
      {lines.map((line, i) => {
        const kind = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+") && !line.startsWith("+++")
            ? "added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "removed"
              : "context"
        const bg =
          kind === "added"
            ? "rgba(34,197,94,0.12)"
            : kind === "removed"
              ? "rgba(248,113,113,0.13)"
              : kind === "hunk"
                ? "rgba(96,165,250,0.12)"
                : "transparent"
        const color =
          kind === "added"
            ? "#22c55e"
            : kind === "removed"
              ? "#f87171"
              : kind === "hunk"
                ? "var(--accent)"
                : "var(--text)"
        return (
          <div
            key={i}
            {...stylex.props(inlineStyles.inline56)}
            style={{
              background: bg,
              borderLeft:
                kind === "added"
                  ? "3px solid #22c55e"
                  : kind === "removed"
                    ? "3px solid #f87171"
                    : kind === "hunk"
                      ? "3px solid var(--accent)"
                      : "3px solid transparent",
            }}
          >
            <span {...stylex.props(inlineStyles.inline57)}>{i + 1}</span>
            <span
              {...stylex.props(inlineStyles.inline58)}
              style={{
                color,
              }}
            >
              {line || "\u00a0"}
            </span>
          </div>
        )
      })}
    </div>
  )
}
function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (
    result as ToolResultMessage & {
      details?: unknown
    }
  ).details
  if (!isRecord(details)) return null
  const patch = typeof details.patch === "string" ? details.patch : null
  if (patch)
    return {
      text: patch,
    }
  const diff = typeof details.diff === "string" ? details.diff : null
  if (diff)
    return {
      text: diff,
    }
  return null
}
function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase()
  return (
    name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor")
  )
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function PairedResult({ text, isEmpty, isError }: { text: string; isEmpty: boolean; isError: boolean }) {
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        {...stylex.props(inlineStyles.inline59)}
        style={{
          color: isError ? "#f87171" : isEmpty ? "var(--text-dim)" : "var(--text-muted)",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? "(no output)" : text}
      </pre>
    </div>
  )
}
function CompactionMessageView({ message }: { message: CustomMessage }) {
  const summary = getMessageText(message.content)
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary])
  const time = formatTime(message.timestamp)
  return (
    <div {...stylex.props(inlineStyles.inline60)}>
      <div {...stylex.props(inlineStyles.inline61)}>
        <div {...stylex.props(inlineStyles.inline62)}>
          <span {...stylex.props(inlineStyles.inline63)}>compaction</span>
          {time && <span {...stylex.props(inlineStyles.inline64)}>{time}</span>}
        </div>

        <div {...stylex.props(inlineStyles.inline65)}>
          <div {...stylex.props(inlineStyles.inline66)}>Conversation compacted</div>
          <div {...stylex.props(inlineStyles.inline67)}>
            The conversation history before this point was compacted into the following summary:
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
            <span {...stylex.props(inlineStyles.inline68)}>(no summary)</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  )
}
function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { locale, t } = useI18n()
  const total = readFiles.length + modifiedFiles.length
  if (total === 0) return null
  const parts = []
  if (readFiles.length > 0) parts.push(locale === "zh-CN" ? `读取 ${readFiles.length} 个` : `${readFiles.length} read`)
  if (modifiedFiles.length > 0)
    parts.push(locale === "zh-CN" ? `修改 ${modifiedFiles.length} 个` : `${modifiedFiles.length} modified`)
  return (
    <details className="compaction-file-details">
      <summary>
        {t("File context")}: {parts.join(", ")}
      </summary>
      {modifiedFiles.length > 0 && <CompactionFileList title={t("Modified files")} files={modifiedFiles} />}
      {readFiles.length > 0 && <CompactionFileList title={t("Read files")} files={readFiles} />}
    </details>
  )
}
function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  )
}
function CustomMessageView({
  message,
  cwd,
  onOpenFile,
}: {
  message: CustomMessage
  cwd?: string
  onOpenFile?: (filePath: string) => void
}) {
  const isHiddenDisplay = message.display === false
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay)
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = getMessageText(message.content)
  const images = getMessageImages(message.content)
  const hasDetails = message.details !== undefined
  const detailsText = hasDetails ? safeJson(message.details) : ""
  const title = formatCustomType(message.customType)
  const time = formatTime(message.timestamp)
  const copyContent = () => {
    runBrowser(
      copyText(text || detailsText).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }
  return (
    <div {...stylex.props(inlineStyles.inline69)}>
      <div
        {...stylex.props(inlineStyles.inline70)}
        style={{
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div {...stylex.props(inlineStyles.inline71)}>
          <span {...stylex.props(inlineStyles.inline72)}>{title}</span>
          {isHiddenDisplay && <span {...stylex.props(inlineStyles.inline73)}>hidden extension message</span>}
          {time && <span {...stylex.props(inlineStyles.inline74)}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div {...stylex.props(inlineStyles.inline75)}>
            {images.length > 0 && (
              <div
                {...stylex.props(inlineStyles.inline76)}
                style={{
                  marginBottom: text ? 8 : 0,
                }}
              >
                {images.map((img, i) => {
                  const src = imageSource(img)
                  if (!src) return null
                  return <img key={i} src={src} alt="" {...stylex.props(inlineStyles.inline77)} />
                })}
              </div>
            )}
            {text ? (
              <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
                {text}
              </MarkdownBody>
            ) : (
              <span {...stylex.props(inlineStyles.inline78)}>(no message)</span>
            )}
          </div>
        ) : (
          <button onClick={() => setContentExpanded(true)} {...stylex.props(inlineStyles.inline79)}>
            {text ? previewText(text) : "Show extension message"}
          </button>
        )}

        <div {...stylex.props(inlineStyles.inline80)}>
          {text || detailsText ? (
            <button
              onClick={copyContent}
              {...stylex.props(inlineStyles.inline81)}
              style={{
                color: copied ? "var(--accent)" : "var(--text-dim)",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v)
                else setDetailsExpanded((v) => !v)
              }}
              {...stylex.props(inlineStyles.inline82)}
            >
              {isHiddenDisplay
                ? contentExpanded
                  ? "Collapse"
                  : "Expand"
                : detailsExpanded
                  ? "Hide details"
                  : "Show details"}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre {...stylex.props(inlineStyles.inline83)}>{detailsText}</pre>
        )}
      </div>
    </div>
  )
}
function getMessageText(content: CustomMessage["content"]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}
function getMessageImages(content: CustomMessage["content"]): ImageContent[] {
  if (typeof content === "string") return []
  return content.filter((b): b is ImageContent => b.type === "image")
}
function imageSource(img: ImageContent): string {
  return img.source.type === "base64" ? `data:${img.source.media_type};base64,${img.source.data}` : img.source.url
}
function safeJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}
function formatCustomType(type: string): string {
  return type || "extension"
}
function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return "Show extension message"
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized
}
function getToolResultText(result?: ToolResultMessage): string | null {
  if (!result) return null
  return result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
function getToolPreview(block: ToolCallContent): string {
  const input = block.input
  if (!input || typeof input !== "object") return ""
  const keys = Object.keys(input)
  if (keys.length === 0) return ""

  // Common tool input patterns
  if ("command" in input) return previewToolValue(input.command)
  if ("path" in input) return previewToolValue(input.path)
  if ("file_path" in input) return previewToolValue(input.file_path)
  if ("pattern" in input) return previewToolValue(input.pattern)
  if ("query" in input) return previewToolValue(input.query)
  const first = input[keys[0]]
  return previewToolValue(first)
}
function previewToolValue(value: JsonValue): string {
  return (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 120)
}
export function TurnUsageSummary({
  usage,
  ongoing = false,
  modelNames,
  timestamp,
}: {
  usage: TurnUsage
  ongoing?: boolean
  modelNames?: Record<string, string>
  timestamp?: number
}) {
  const { locale, t } = useI18n()
  const modelLabel = usage.models
    .map(({ provider, model }) => modelNames?.[`${provider}:${model}`] ?? modelNames?.[model] ?? model)
    .join(" / ")
  const callCount =
    locale === "zh-CN"
      ? `${usage.modelCalls} 次模型调用`
      : `${usage.modelCalls} model ${usage.modelCalls === 1 ? "call" : "calls"}`
  const rows: Array<[string, string]> = [
    ...(modelLabel ? [[t("Model"), modelLabel] as [string, string]] : []),
    [t("Input"), usage.input.toLocaleString()],
    [t("Output"), usage.output.toLocaleString()],
    ...(usage.cacheRead > 0 ? [[t("Cache Read"), usage.cacheRead.toLocaleString()] as [string, string]] : []),
    ...(usage.cacheWrite > 0 ? [[t("Cache Write"), usage.cacheWrite.toLocaleString()] as [string, string]] : []),
    [t("Billed tokens"), usage.totalTokens.toLocaleString()],
    [t("Total cost"), `$${usage.cost.toFixed(6)}`],
    ...(usage.durationMs !== null ? [[t("Duration"), formatDuration(usage.durationMs)] as [string, string]] : []),
    ...(usage.lastCallCost !== null ? [[t("Last call"), `$${usage.lastCallCost.toFixed(6)}`] as [string, string]] : []),
    ...(usage.lastCallDurationMs !== null
      ? [[t("Last call duration"), formatDuration(usage.lastCallDurationMs)] as [string, string]]
      : []),
  ]
  return (
    <details {...stylex.props(inlineStyles.inline84)}>
      <summary title={t("Show turn usage details")} {...stylex.props(inlineStyles.inline85)}>
        {modelLabel && (
          <>
            <span>{modelLabel}</span>
            <span>·</span>
          </>
        )}
        <span>{ongoing ? t("Turn in progress") : t("This turn")}</span>
        <span>·</span>
        <span {...stylex.props(inlineStyles.inline86)}>${usage.cost.toFixed(4)}</span>
        {!ongoing && usage.durationMs !== null && (
          <>
            <span>·</span>
            <span>{formatDuration(usage.durationMs)}</span>
          </>
        )}
        {!ongoing && (
          <>
            <span>·</span>
            <span>{callCount}</span>
          </>
        )}
        {!ongoing && timestamp !== undefined && (
          <time {...stylex.props(inlineStyles.turnTimestamp)}>{formatClockTime(timestamp)}</time>
        )}
      </summary>
      <div {...stylex.props(inlineStyles.inline87)}>
        <div {...stylex.props(inlineStyles.inline88)}>{t("Turn usage")}</div>
        <div {...stylex.props(inlineStyles.inline89)}>
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <span {...stylex.props(inlineStyles.inline90)}>{label}</span>
              <span {...stylex.props(inlineStyles.inline91)}>{value}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </details>
  )
}
function formatUsage(
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: {
      total: number
    }
  },
  durationMs: number | null,
): string {
  const parts = []
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`)
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`)
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`)
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`)
  if (durationMs !== null) parts.push(formatDuration(durationMs))
  return parts.join(" · ")
}
const inlineStyles = stylex.create({
  inline1: {
    marginBottom: 16,
  },
  inline2: {
    overflow: "hidden",
    border: "1px solid var(--border)",
    borderRadius: 9,
    background: "var(--bg-panel)",
  },
  inline3: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-muted)",
    fontSize: 11,
  },
  inline4: {
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
  },
  inline5: {
    flex: 1,
    minWidth: 0,
    color: "var(--text)",
    overflowWrap: "anywhere",
  },
  inline6: {
    flexShrink: 0,
  },
  inline7: {
    margin: 0,
    padding: "10px 12px",
    maxHeight: 420,
    overflow: "auto",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  inline8: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderTop: "1px solid var(--border)",
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline9: {
    marginLeft: "auto",
    overflowWrap: "anywhere",
  },
  inline10: {
    marginBottom: 25,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    position: "relative",
  },
  inline11: {
    display: "flex",
    alignItems: "flex-end",
    gap: 6,
    maxWidth: { default: "68%", "@media (max-width: 760px)": "88%" },
    width: "fit-content",
  },
  inline12: {
    flex: "0 1 auto",
    maxWidth: "100%",
    minWidth: 0,
    background: "var(--bg-subtle)",
    border: "none",
    borderRadius: 12,
    padding: "13px 15px",
    fontSize: 14,
    lineHeight: 1.6,
    color: "var(--text)",
    wordBreak: "break-word",
  },
  inline13: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  inline14: {
    maxWidth: 240,
    maxHeight: 240,
    borderRadius: 6,
    objectFit: "contain",
    display: "block",
    border: "1px solid rgba(59,130,246,0.15)",
  },
  inline15: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    bottom: -22,
    marginTop: 0,
    position: "absolute",
    right: 0,
  },
  inline16: {
    display: "flex",
    gap: 3,
    transition: "opacity 0.12s",
  },
  inline17: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    height: 22,
    background: "none",
    border: "none",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 400,
    whiteSpace: "nowrap",
    transition: "color 0.12s",
  },
  inline18: {
    display: "flex",
    gap: 3,
    transition: "opacity 0.12s",
  },
  inline19: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    height: 22,
    background: "none",
    border: "none",
    borderRadius: 5,
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 400,
    whiteSpace: "nowrap",
    transition: "color 0.12s",
  },
  inline20: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    height: 22,
    background: "none",
    border: "none",
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 400,
    whiteSpace: "nowrap",
    transition: "color 0.12s",
  },
  inline22: {
    marginBottom: 25,
  },
  inline27: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  inline28: {
    padding: "9px 11px",
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  inline29: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  inline30: {
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline31: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    height: 22,
    background: "none",
    border: "none",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 400,
    whiteSpace: "nowrap",
    transition: "opacity 0.12s, color 0.12s",
  },
  inline32: {
    fontSize: 10,
    color: "var(--text-dim)",
    marginLeft: "auto",
  },
  inline33: {
    border: "1px solid var(--border)",
    borderRadius: 6,
    overflow: "hidden",
    fontSize: 13,
  },
  inline34: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "6px 10px",
    background: "var(--bg-panel)",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
  },
  inline35: {
    marginLeft: "auto",
    fontSize: 11,
    color: "var(--text-dim)",
    fontVariantNumeric: "tabular-nums",
  },
  inline36: {
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    background: "var(--bg-panel)",
    borderTop: "1px solid var(--border)",
  },
  inline37: {
    borderRadius: 7,
    overflow: "hidden",
    fontSize: 12,
  },
  inline38: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "6px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
    minWidth: 0,
  },
  inline39: {
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    fontSize: 11,
    flexShrink: 0,
  },
  inline40: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
  },
  inline41: {
    fontSize: 11,
    color: "var(--text-dim)",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  inline42: {
    flexShrink: 0,
    transition: "transform 0.15s",
  },
  inline43: {
    margin: 0,
    padding: "8px 10px",
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
    overflow: "auto",
    background: "var(--bg-subtle)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  inline44: {
    borderTop: "1px solid rgba(34,197,94,0.15)",
    background: "var(--bg)",
  },
  inline45: {
    maxHeight: 560,
    overflowY: "auto",
    overflowX: "hidden",
    background: "var(--bg)",
  },
  inline46: {
    minWidth: 0,
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.55,
  },
  inline47: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
  },
  inline48: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  },
  inline49: {
    display: "contents",
  },
  inline50: {
    padding: "5px 10px",
    color: "var(--text-dim)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline51: {
    display: "flex",
    minWidth: 0,
  },
  inline52: {
    width: 42,
    padding: "0 6px",
    textAlign: "right",
    color: "var(--text-dim)",
    userSelect: "none",
    background: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline53: {
    width: 18,
    padding: "0 5px",
    userSelect: "none",
    flexShrink: 0,
  },
  inline54: {
    flex: 1,
    minWidth: 0,
    padding: "0 10px 0 0",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  inline55: {
    maxHeight: 520,
    overflowY: "auto",
    overflowX: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.55,
    minWidth: 0,
  },
  inline56: {
    display: "flex",
  },
  inline57: {
    width: 48,
    padding: "0 8px",
    color: "var(--text-dim)",
    background: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    textAlign: "right",
    userSelect: "none",
    flexShrink: 0,
  },
  inline58: {
    padding: "0 10px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  inline59: {
    margin: 0,
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.5,
    overflow: "auto",
    maxHeight: 400,
    background: "var(--bg)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  inline60: {
    marginBottom: 16,
  },
  inline61: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflow: "hidden",
    background: "var(--bg)",
  },
  inline62: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
  },
  inline63: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 650,
  },
  inline64: {
    marginLeft: "auto",
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline65: {
    padding: "11px 13px 12px",
  },
  inline66: {
    color: "var(--text)",
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.35,
  },
  inline67: {
    marginTop: 3,
    marginBottom: 10,
    color: "var(--text)",
    fontSize: 14,
    lineHeight: 1.5,
  },
  inline68: {
    color: "var(--text-dim)",
    fontSize: 12,
  },
  inline69: {
    marginBottom: 16,
  },
  inline70: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflow: "hidden",
  },
  inline71: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    fontSize: 12,
  },
  inline72: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 650,
  },
  inline73: {
    color: "var(--text-dim)",
    fontSize: 11,
  },
  inline74: {
    marginLeft: "auto",
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline75: {
    padding: "6px 9px",
  },
  inline76: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  inline77: {
    maxWidth: 240,
    maxHeight: 240,
    borderRadius: 6,
    objectFit: "contain",
    display: "block",
    border: "1px solid var(--border)",
  },
  inline78: {
    color: "var(--text-dim)",
    fontSize: 12,
  },
  inline79: {
    display: "block",
    width: "100%",
    padding: "8px 10px",
    border: "none",
    background: "transparent",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
  },
  inline80: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 9px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-subtle)",
  },
  inline81: {
    padding: "3px 7px",
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 11,
  },
  inline82: {
    marginLeft: "auto",
    padding: "3px 7px",
    border: "none",
    background: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: 11,
  },
  inline83: {
    margin: 0,
    padding: "9px 10px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 360,
    overflow: "auto",
    fontFamily: "var(--font-mono)",
  },
  inline84: {
    position: "relative",
    fontVariantNumeric: "tabular-nums",
    width: "100%",
  },
  inline85: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    listStyle: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: 11,
    whiteSpace: "nowrap",
  },
  inline86: {
    color: "var(--text-muted)",
    fontWeight: 500,
  },
  turnTimestamp: {
    color: "var(--text-dim)",
    fontSize: 10,
    marginLeft: "auto",
  },
  inline87: {
    position: "absolute",
    bottom: "calc(100% + 7px)",
    left: 0,
    zIndex: 70,
    width: "min(280px, calc(100vw - 48px))",
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-panel)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.18)",
  },
  inline88: {
    marginBottom: 8,
    color: "var(--text)",
    fontSize: 12,
    fontWeight: 600,
  },
  inline89: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "5px 16px",
    fontSize: 11,
  },
  inline90: {
    color: "var(--text-muted)",
  },
  inline91: {
    color: "var(--text)",
    textAlign: "right",
  },
  processRow: {
    minWidth: 0,
    position: "relative",
  },
  processRowButton: {
    alignItems: "center",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    display: "flex",
    gap: 9,
    minHeight: 37,
    minWidth: 0,
    padding: 0,
    textAlign: "left",
    width: "100%",
  },
  processRowState: {
    alignItems: "center",
    borderRadius: "50%",
    display: "flex",
    flex: "0 0 auto",
    height: 17,
    justifyContent: "center",
    position: "relative",
    width: 17,
    zIndex: 1,
  },
  processRowRunningDot: {
    background: "var(--accent)",
    borderRadius: "50%",
    boxShadow: "0 0 0 4px var(--accent-soft)",
    height: 5,
    width: 5,
  },
  processRowCopy: {
    alignItems: "baseline",
    display: "flex",
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  processRowLabel: {
    flex: "0 0 auto",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 600,
  },
  processRowPreview: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  processRowDuration: {
    color: "var(--text-dim)",
    flex: "0 0 auto",
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  processRowChevron: {
    color: "var(--text-dim)",
    flex: "0 0 auto",
    transition: "transform 0.14s",
  },
  processRowDetailsStack: {
    borderTop: "1px solid var(--border-soft)",
  },
  processRowDetails: {
    background: "var(--bg-subtle)",
    border: "none",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    lineHeight: 1.55,
    margin: 0,
    maxHeight: 240,
    overflow: "auto",
    padding: "8px 10px 8px 26px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
})
