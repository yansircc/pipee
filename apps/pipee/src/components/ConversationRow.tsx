import { memo } from "react"
import type { AssistantMessage } from "@/api/contract"
import type { DisplayRow } from "@/lib/disclosure-projection"
import { AgentTraceItemsView, MessageView, StreamingThroughputBadge, TurnUsageSummary } from "./MessageView"
import { PresentationSurface } from "./PresentationSurface"

interface Props {
  readonly row: DisplayRow
  readonly sessionId: string
  readonly cwd: string
  readonly modelNames: Record<string, string>
  readonly sessionBusy: boolean
  readonly forkingEntryId?: string | null
  readonly previousAssistantEntryId?: string
  readonly onOpenFile?: (path: string) => void
  readonly onFork: (entryId: string) => void
  readonly onNavigate: (entryId: string) => void
  readonly onEditContent: (content: string) => void
  readonly onToggleTrace: (traceId: string) => void
  readonly onToggleExtension: (id: string) => void
  readonly onToggleTelemetry: (turnId: string, expanded: boolean) => void
}

const assistantWithBlocks = (row: Extract<DisplayRow, { kind: "assistant-content" }>): AssistantMessage => ({
  ...row.node.message,
  content: row.node.blocks.map(({ block }) => block),
  stopReason: undefined,
  errorMessage: undefined,
  usage: undefined,
})

const lastAssistant = (row: Extract<DisplayRow, { kind: "turn-telemetry" }>): AssistantMessage | null => {
  for (let index = row.turn.flow.length - 1; index >= 0; index -= 1) {
    const node = row.turn.flow[index]
    if (node.kind === "assistant-content") return node.message
    if (node.kind === "agent-trace") {
      const item = node.items.findLast((candidate) => candidate.kind === "thinking" || candidate.kind === "tool")
      if (item?.kind === "thinking" || item?.kind === "tool") return item.message
    }
  }
  return null
}

export const ConversationRow = memo(function ConversationRow(props: Props) {
  const { row } = props
  if (row.kind === "turn-user") {
    const entryId = row.turn.user.source.entryId
    return (
      <div data-transcript-row={row.id} data-turn-id={row.turn.id}>
        <MessageView
          message={row.turn.user.message}
          cwd={props.cwd}
          onOpenFile={props.onOpenFile}
          entryId={entryId}
          onFork={props.sessionBusy || entryId === undefined ? undefined : props.onFork}
          forking={entryId !== undefined && props.forkingEntryId === entryId}
          onNavigate={props.sessionBusy ? undefined : props.onNavigate}
          prevAssistantEntryId={props.previousAssistantEntryId}
          onEditContent={props.onEditContent}
        />
      </div>
    )
  }
  if (row.kind === "assistant-content") {
    return (
      <div data-transcript-row={row.id}>
        <MessageView
          message={assistantWithBlocks(row)}
          isStreaming={row.node.source.kind === "streaming"}
          modelNames={props.modelNames}
          cwd={props.cwd}
          onOpenFile={props.onOpenFile}
          entryId={row.node.source.entryId}
          sessionId={props.sessionId}
          hideUsage
          turnSegment
          blockIndices={row.node.blocks.map(({ blockIndex }) => blockIndex)}
        />
      </div>
    )
  }
  if (row.kind === "agent-trace") {
    return (
      <section data-transcript-row={row.id} aria-busy={row.node.status === "running"} className="agent-trace">
        <button
          type="button"
          className="agent-trace-summary"
          aria-expanded={row.expanded}
          onClick={() => props.onToggleTrace(row.id)}
        >
          <span aria-hidden="true">{row.node.status === "running" ? "●" : "✓"}</span>
          <strong>{row.summary}</strong>
          <span aria-hidden="true">{row.expanded ? "⌄" : "›"}</span>
        </button>
        {row.visibleItems.length > 0 && (
          <div className="agent-trace-items">
            <AgentTraceItemsView items={row.visibleItems} sessionId={props.sessionId} />
          </div>
        )}
      </section>
    )
  }
  if (row.kind === "turn-telemetry") {
    const assistant = lastAssistant(row)
    return (
      <div data-transcript-row={row.id} className="turn-telemetry">
        {row.turn.status === "running" && assistant !== null && <StreamingThroughputBadge message={assistant} />}
        {row.turn.telemetry !== null && (
          <TurnUsageSummary
            usage={row.turn.telemetry}
            ongoing={row.turn.status === "running"}
            modelNames={props.modelNames}
            timestamp={assistant?.timestamp}
            expanded={row.expanded}
            onExpandedChange={(expanded) => props.onToggleTelemetry(row.turn.id, expanded)}
          />
        )}
      </div>
    )
  }
  if (row.kind === "termination") {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: "",
      provider: "",
      stopReason: row.node.reason === "aborted" ? "aborted" : "error",
      errorMessage: row.node.message,
    }
    return (
      <div data-transcript-row={row.id}>
        <MessageView message={message} turnSegment hideUsage />
      </div>
    )
  }
  if (row.kind === "extension-content") {
    return (
      <div data-transcript-row={row.id}>
        {row.expanded ? (
          <MessageView message={{ ...row.node.message, display: true }} cwd={props.cwd} onOpenFile={props.onOpenFile} />
        ) : (
          <button
            type="button"
            className="extension-placeholder"
            aria-expanded="false"
            onClick={() => props.onToggleExtension(row.id)}
          >
            Extension event · {row.node.message.customType}
          </button>
        )}
      </div>
    )
  }
  if (row.kind === "presentation") {
    if (row.node.document === null) {
      return (
        <div data-transcript-row={row.id} className="conversation-view-fallback">
          {row.node.message.role === "toolResult" ? (
            <AgentTraceItemsView
              sessionId={props.sessionId}
              items={[
                {
                  kind: "unmatched-tool-result",
                  id: `${row.id}:fallback`,
                  source: row.node.source,
                  message: row.node.message,
                },
              ]}
            />
          ) : (
            <MessageView
              message={{ ...row.node.message, display: true }}
              cwd={props.cwd}
              onOpenFile={props.onOpenFile}
            />
          )}
        </div>
      )
    }
    return (
      <div data-transcript-row={row.id}>
        <PresentationSurface mode="artifact" document={row.node.document} />
      </div>
    )
  }
  if (row.kind === "user-command") {
    return (
      <div data-transcript-row={row.id}>
        <MessageView message={row.node.message} isStreaming={row.node.status === "running"} />
      </div>
    )
  }
  if (row.kind === "context-boundary") {
    return (
      <div data-transcript-row={row.id}>
        <MessageView message={row.node.message} />
      </div>
    )
  }
  if (row.node.message.role === "toolResult") {
    return (
      <div data-transcript-row={row.id}>
        <AgentTraceItemsView
          sessionId={props.sessionId}
          items={[
            {
              kind: "unmatched-tool-result",
              id: `${row.id}:diagnostic`,
              source: row.node.source,
              message: row.node.message,
            },
          ]}
        />
      </div>
    )
  }
  return (
    <div data-transcript-row={row.id}>
      <MessageView message={row.node.message} cwd={props.cwd} onOpenFile={props.onOpenFile} />
    </div>
  )
})
