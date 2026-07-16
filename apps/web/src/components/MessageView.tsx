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
  callbacks: { readonly onSuccess: (thinking: string) => void; readonly onFailure: (error: unknown) => void },
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
        params: { id: sessionId },
        query: { entryId, blockIndex },
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

function BashExecutionMessageView({ message, running = false }: { message: BashExecutionMessage; running?: boolean }) {
  const { t } = useI18n()
  const status = running
    ? t("Running…")
    : message.cancelled
      ? t("Cancelled")
      : t("Exit code {code}", { code: message.exitCode ?? "—" })

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          overflow: "hidden",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: 11,
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 700 }}>$</span>
          <code style={{ flex: 1, minWidth: 0, color: "var(--text)", overflowWrap: "anywhere" }}>
            {message.command}
          </code>
          <span style={{ flexShrink: 0 }}>{status}</span>
        </div>
        <pre
          style={{
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
          }}
        >
          {message.output || (running ? t("Running…") : t("No output"))}
        </pre>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderTop: "1px solid var(--border)",
            color: "var(--text-dim)",
            fontSize: 10,
          }}
        >
          <span>{message.excludeFromContext ? t("Excluded from context") : t("Included in context")}</span>
          {message.truncated && <span>· {t("Output truncated")}</span>}
          {message.fullOutputPath && (
            <code style={{ marginLeft: "auto", overflowWrap: "anywhere" }}>{message.fullOutputPath}</code>
          )}
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

  const time = formatTime(message.timestamp)
  const canFork = !!entryId && !!onFork
  const canNavigate = !!prevAssistantEntryId && !!onNavigate

  const copyContent = () => {
    runBrowser(
      copyText(content).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      { onSuccess: () => undefined },
    )
  }

  return (
    <div
      style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                const src =
                  img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url
                return (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{
                      maxWidth: 240,
                      maxHeight: 240,
                      borderRadius: 6,
                      objectFit: "contain",
                      display: "block",
                      border: "1px solid rgba(59,130,246,0.15)",
                    }}
                  />
                )
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          marginTop: 3,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 3,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.12s",
          }}
        >
          <button
            onClick={copyContent}
            title={t("Copy message")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 22,
              background: "none",
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 400,
              whiteSpace: "nowrap",
              transition: "color 0.12s",
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
            style={{
              display: "flex",
              gap: 3,
              opacity: hovered || forking ? 1 : 0,
              pointerEvents: hovered || forking ? "auto" : "none",
              transition: "opacity 0.12s",
            }}
          >
            {canNavigate && (
              <button
                onClick={() => {
                  onNavigate!(prevAssistantEntryId!)
                  onEditContent?.(content)
                }}
                title={t("Edit from here — branches within this session")}
                style={{
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
                }}
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
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 8px",
                  height: 22,
                  background: "none",
                  border: "none",
                  borderRadius: 5,
                  color: forking ? "var(--accent)" : "var(--text-dim)",
                  cursor: forking ? "not-allowed" : "pointer",
                  fontSize: 11,
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                  transition: "color 0.12s",
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
        {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
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
}) {
  const { t } = useI18n()
  const time = showTimestamp ? formatTime(message.timestamp) : null
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }))
  const blocks = blockItems.map(({ block }) => block)
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const streamStartRef = useRef<number | null>(null)
  const [tps, setTps] = useState<number | null>(null)
  const blockItemsRef = useRef(blockItems)
  blockItemsRef.current = blockItems

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map())
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map())

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000)
    return secs > 0 ? secs : undefined
  }, [message.timestamp, prevTimestamp])

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()
    if (!toolResults || !message.timestamp) return map
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000)
        if (secs > 0) map.set(callId, secs)
      }
    }
    return map
  }, [toolResults, message.timestamp])

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
  const termination =
    message.stopReason === "aborted"
      ? { label: t("Cancelled"), message: undefined, error: false }
      : message.errorMessage?.trim()
        ? { label: t("Error"), message: message.errorMessage.trim(), error: true }
        : undefined

  const copyContent = () => {
    runBrowser(
      copyText(textContent).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.andThen(Effect.sleep("1500 millis")),
        Effect.tap(() => Effect.sync(() => setCopied(false))),
      ),
      { onSuccess: () => undefined },
    )
  }

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      streamStartRef.current = null
      setTps(null)
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
      const bs = items.map(({ block }) => block)

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

      let chars = 0
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length
      }
      if (chars === 0) return
      if (streamStartRef.current === null) streamStartRef.current = now
      const elapsed = (now - streamStartRef.current) / 1000
      if (elapsed > 0.5) setTps(chars / 4 / elapsed)
    }
    return runApi(
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Effect.sync(() => tick(now))),
        Effect.andThen(Effect.sleep("300 millis")),
        Effect.forever,
      ),
      { onSuccess: () => undefined },
    )
  }, [isStreaming])

  if (blocks.length === 0 && termination === undefined && !isStreaming) return null

  return (
    <div style={{ marginBottom: 16 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>
            {modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}
          </span>
        )}
        {isStreaming &&
          (() => {
            let chars = 0
            for (const b of blocks) {
              if (b.type === "text") chars += (b as TextContent).text?.length ?? 0
              else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0
              else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length
            }
            const est = Math.round(chars / 4)
            return (
              <>
                {est > 0 && (
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }}
                    title={t("Estimated token count while streaming")}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="5" y1="1.5" x2="5" y2="8.5" />
                        <polyline points="2 6 5 8.5 8 6" />
                      </svg>
                      {est}
                    </span>
                    {tps !== null &&
                      (() => {
                        const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f"
                        return (
                          <span
                            style={{
                              marginLeft: 6,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: bg,
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 400,
                            }}
                          >
                            {tps.toFixed(1)} t/s
                          </span>
                        )
                      })()}
                  </span>
                )}
              </>
            )
          })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {termination !== undefined && (
          <div
            role={termination.error ? "alert" : "status"}
            style={{
              padding: "9px 11px",
              border: termination.error ? "1px solid rgba(220, 38, 38, 0.35)" : "1px solid var(--border)",
              borderRadius: 8,
              background: termination.error ? "rgba(220, 38, 38, 0.08)" : "var(--bg-panel)",
              color: termination.error ? "#dc2626" : "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
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

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 4,
        }}
      >
        {turnUsage && !isStreaming ? (
          <TurnUsageSummary usage={turnUsage} />
        ) : message.usage && !isStreaming && !hideUsage ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage, elapsedDuration(prevTimestamp, message.timestamp))}
          </div>
        ) : null}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title={t("Copy message")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 8px",
              height: 22,
              background: "none",
              border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
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
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
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

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <button
        onClick={toggle}
        style={{
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
        }}
      >
        <span>{t("Thinking")}</span>
        {duration !== undefined && (
          <span
            style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
          >
            {duration}s
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            color: error ? "#f87171" : "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {loading ? "Loading thinking..." : (error ?? (block.deferred ? content : block.thinking))}
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
  const resultText = result
    ? result.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : null
  const resultIsEmpty = resultText === null ? false : resultText.trim() === "(no output)" || resultText.trim() === ""
  const isError = result?.isError ?? false

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
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
        }}
      >
        <span
          style={{
            color: isError ? "#f87171" : "#16a34a",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {block.toolName}
        </span>
        <span
          style={{
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {getToolPreview(block)}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {duration}s
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="var(--text-dim)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && !isEditTool && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
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
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  )
}

function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text])
  if (!files) return <PatchTextView text={text} />
  const showFileHeaders = files.length > 1

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <SplitDiffHeader title={file.oldPath || "Before"} side="left" />
              <SplitDiffHeader title={file.newPath || "After"} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
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
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
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
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
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
    <div
      style={{
        maxHeight: 520,
        overflowY: "auto",
        overflowX: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.55,
        minWidth: 0,
      }}
    >
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
            style={{
              display: "flex",
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
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details
  if (!isRecord(details)) return null

  const patch = typeof details.patch === "string" ? details.patch : null
  if (patch) return { text: patch }

  const diff = typeof details.diff === "string" ? details.diff : null
  if (diff) return { text: diff }

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
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : isEmpty ? "var(--text-dim)" : "var(--text-muted)",
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
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
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>compaction</span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>
            Conversation compacted
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>
            The conversation history before this point was compacted into the following summary:
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>(no summary)</span>
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
      { onSuccess: () => undefined },
    )
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
          {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>hidden extension message</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img)
                  if (!src) return null
                  return (
                    <img
                      key={i}
                      src={src}
                      alt=""
                      style={{
                        maxWidth: 240,
                        maxHeight: 240,
                        borderRadius: 6,
                        objectFit: "contain",
                        display: "block",
                        border: "1px solid var(--border)",
                      }}
                    />
                  )
                })}
              </div>
            )}
            {text ? (
              <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
                {text}
              </MarkdownBody>
            ) : (
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>(no message)</span>
            )}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {text ? previewText(text) : "Show extension message"}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
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
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
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
          <pre
            style={{
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
            }}
          >
            {detailsText}
          </pre>
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

export function TurnUsageSummary({ usage, ongoing = false }: { usage: TurnUsage; ongoing?: boolean }) {
  const { locale, t } = useI18n()
  const callCount =
    locale === "zh-CN"
      ? `${usage.modelCalls} 次模型调用`
      : `${usage.modelCalls} model ${usage.modelCalls === 1 ? "call" : "calls"}`
  const rows: Array<[string, string]> = [
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
    <details style={{ position: "relative", fontVariantNumeric: "tabular-nums" }}>
      <summary
        title={t("Show turn usage details")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          listStyle: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        <span>{ongoing ? t("Turn in progress") : t("This turn")}</span>
        <span>·</span>
        <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>${usage.cost.toFixed(4)}</span>
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
      </summary>
      <div
        style={{
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
        }}
      >
        <div style={{ marginBottom: 8, color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{t("Turn usage")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 16px", fontSize: 11 }}>
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <span style={{ color: "var(--text-muted)" }}>{label}</span>
              <span style={{ color: "var(--text)", textAlign: "right" }}>{value}</span>
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
    cost: { total: number }
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
