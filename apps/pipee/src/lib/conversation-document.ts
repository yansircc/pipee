import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  CustomMessage,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@/api/contract"
import type { ConversationView } from "@pipee/companion-contracts/conversation-view"
import type { TranscriptSource } from "@/features/session/session-ui-state"
import { conversationViewFromDetails } from "./conversation-view"
import { summarizeTurnUsage, type TurnUsage } from "./message-display"

export type SourceIdentity = Pick<TranscriptSource, "id" | "kind" | "runId"> & { readonly entryId?: string }

export interface AssistantContentNode {
  readonly kind: "assistant-content"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: AssistantMessage
  readonly blocks: ReadonlyArray<{ readonly block: AssistantContentBlock; readonly blockIndex: number }>
}

export interface TraceThinkingItem {
  readonly kind: "thinking"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: AssistantMessage
  readonly block: Extract<AssistantContentBlock, { type: "thinking" }>
  readonly blockIndex: number
}

export interface TraceToolItem {
  readonly kind: "tool"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: AssistantMessage
  readonly block: ToolCallContent
  readonly blockIndex: number
  result?: { readonly source: SourceIdentity; readonly message: ToolResultMessage }
}

export interface TraceDiagnosticItem {
  readonly kind: "unmatched-tool-result"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: ToolResultMessage
}

export interface AgentTraceNode {
  readonly kind: "agent-trace"
  readonly id: string
  readonly status: "running" | "completed"
  readonly items: ReadonlyArray<TraceThinkingItem | TraceToolItem | TraceDiagnosticItem>
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface ExtensionContentNode {
  readonly kind: "extension-content"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: CustomMessage
  readonly collapsed: boolean
}

export interface ConversationViewNode {
  readonly kind: "conversation-view"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: ToolResultMessage | CustomMessage
  readonly view: ConversationView | null
}

export interface TerminationNode {
  readonly kind: "termination"
  readonly id: string
  readonly source: SourceIdentity
  readonly reason: "aborted" | "error"
  readonly message?: string
}

export type TurnFlowNode =
  | AssistantContentNode
  | AgentTraceNode
  | ExtensionContentNode
  | ConversationViewNode
  | TerminationNode

export interface TurnNode {
  readonly kind: "turn"
  readonly id: string
  readonly user: { readonly source: SourceIdentity; readonly message: UserMessage }
  readonly flow: ReadonlyArray<TurnFlowNode>
  readonly telemetry: TurnUsage | null
  readonly status: "running" | "completed"
}

export interface UserCommandNode {
  readonly kind: "user-command"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: Extract<AgentMessage, { role: "bashExecution" }>
  readonly status: "running" | "completed"
}

export interface ContextBoundaryNode {
  readonly kind: "context-boundary"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: CustomMessage
}

export interface ExtensionEntryNode {
  readonly kind: "extension-entry"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: CustomMessage
  readonly collapsed: boolean
}

export interface OrphanMessageNode {
  readonly kind: "orphan-message"
  readonly id: string
  readonly source: SourceIdentity
  readonly message: AgentMessage
}

export type DocumentNode =
  | TurnNode
  | UserCommandNode
  | ContextBoundaryNode
  | ExtensionEntryNode
  | ConversationViewNode
  | OrphanMessageNode

export interface TurnIndexEntry {
  readonly turnId: string
  readonly nodeIndex: number
  readonly rowId: string
  readonly promptPreview: string
}

export interface ConversationDocument {
  readonly nodes: ReadonlyArray<DocumentNode>
  readonly turnIndex: ReadonlyArray<TurnIndexEntry>
}

export interface CompileConversationOptions {
  readonly liveRunId?: string | null
}

const nodeMessages = new WeakMap<DocumentNode, ReadonlyArray<AgentMessage>>()

const identityOf = (source: TranscriptSource): SourceIdentity => ({
  id: source.id,
  kind: source.kind,
  runId: source.runId,
  ...(source.kind === "persisted" ? { entryId: source.entryId } : {}),
})

const userText = (message: UserMessage): string =>
  (typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join(" ")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140)

const traceTime = (
  items: ReadonlyArray<TraceThinkingItem | TraceToolItem | TraceDiagnosticItem>,
  edge: "start" | "end",
) => {
  const times = items
    .flatMap((item) =>
      item.kind === "tool" && item.result !== undefined
        ? [item.message.timestamp, item.result.message.timestamp]
        : [item.message.timestamp],
    )
    .filter((value): value is number => typeof value === "number")
  if (times.length === 0) return undefined
  return edge === "start" ? Math.min(...times) : Math.max(...times)
}

export function compileConversationDocument(
  sources: ReadonlyArray<TranscriptSource>,
  options: CompileConversationOptions = {},
  previous?: ConversationDocument,
): ConversationDocument {
  const nodes: DocumentNode[] = []
  let turn: {
    source: TranscriptSource
    node: TurnNode
    messages: AgentMessage[]
    calls: Map<string, TraceToolItem[]>
  } | null = null
  let trace: { node: AgentTraceNode; items: Array<TraceThinkingItem | TraceToolItem | TraceDiagnosticItem> } | null =
    null
  let timelineTimestamp: number | undefined

  const finishTrace = () => {
    if (turn === null || trace === null) return
    const status =
      options.liveRunId !== null && options.liveRunId !== undefined && turn.node.id === `turn:${options.liveRunId}`
        ? ("running" as const)
        : ("completed" as const)
    Object.assign(trace.node, {
      status,
      items: trace.items,
      startedAt: trace.node.startedAt ?? traceTime(trace.items, "start"),
      endedAt: status === "completed" ? traceTime(trace.items, "end") : undefined,
    })
    trace = null
  }
  const finishTurn = () => {
    if (turn === null) return
    finishTrace()
    const live =
      options.liveRunId !== null && options.liveRunId !== undefined && turn.node.id === `turn:${options.liveRunId}`
    const telemetry = summarizeTurnUsage(turn.messages, 0, turn.messages.length)
    Object.assign(turn.node, { telemetry, status: live ? "running" : "completed" })
    for (const flow of turn.node.flow) {
      if (flow.kind !== "agent-trace") continue
      const endedAt = flow.status === "completed" ? traceTime(flow.items, "end") : undefined
      Object.assign(flow, {
        endedAt,
        ...(flow.startedAt !== undefined && endedAt !== undefined && endedAt < flow.startedAt
          ? { startedAt: undefined, endedAt: undefined }
          : {}),
      })
    }
    nodeMessages.set(turn.node, turn.messages)
    turn = null
  }
  const ensureTrace = (startedAt?: number): typeof trace => {
    if (turn === null) return null
    if (trace !== null) return trace
    const node: AgentTraceNode = {
      kind: "agent-trace",
      id: `${turn.node.id}:trace:${turn.node.flow.length}`,
      status: "completed",
      items: [],
      startedAt,
    }
    const items: Array<TraceThinkingItem | TraceToolItem | TraceDiagnosticItem> = []
    ;(turn.node.flow as TurnFlowNode[]).push(node)
    trace = { node, items }
    return trace
  }

  for (const source of sources) {
    const message = source.message
    const priorTimestamp = timelineTimestamp
    if (typeof message.timestamp === "number") timelineTimestamp = message.timestamp
    const sourceIdentity = identityOf(source)
    if (message.role === "user") {
      finishTurn()
      const turnId = source.runId ?? (source.kind === "pending" ? source.runId : null) ?? source.id
      const node: TurnNode = {
        kind: "turn",
        id: `turn:${turnId}`,
        user: { source: sourceIdentity, message },
        flow: [],
        telemetry: null,
        status: "completed",
      }
      nodes.push(node)
      turn = { source, node, messages: [message], calls: new Map() }
      continue
    }
    if (message.role === "bashExecution") {
      finishTurn()
      nodes.push({
        kind: "user-command",
        id: `command:${source.id}`,
        source: sourceIdentity,
        message,
        status: source.kind === "active-bash" ? "running" : "completed",
      })
      nodeMessages.set(nodes.at(-1)!, [message])
      continue
    }
    if (message.role === "custom" && message.customType === "compaction") {
      finishTurn()
      nodes.push({ kind: "context-boundary", id: `boundary:${source.id}`, source: sourceIdentity, message })
      nodeMessages.set(nodes.at(-1)!, [message])
      continue
    }
    if (turn === null) {
      if (message.role === "custom" || message.role === "toolResult") {
        const conversationView = conversationViewFromDetails(message.details)
        if (conversationView !== null) {
          nodes.push({
            kind: "conversation-view",
            id: `conversation-view:${source.id}`,
            source: sourceIdentity,
            message,
            view: conversationView._tag === "Valid" ? conversationView.view : null,
          })
          nodeMessages.set(nodes.at(-1)!, [message])
          continue
        }
      }
      if (message.role === "custom") {
        nodes.push({
          kind: "extension-entry",
          id: `extension:${source.id}`,
          source: sourceIdentity,
          message,
          collapsed: !message.display,
        })
        nodeMessages.set(nodes.at(-1)!, [message])
      } else {
        nodes.push({ kind: "orphan-message", id: `orphan:${source.id}`, source: sourceIdentity, message })
        nodeMessages.set(nodes.at(-1)!, [message])
      }
      continue
    }
    turn.messages.push(message)
    if (message.role === "assistant") {
      let content: Array<{ block: AssistantContentBlock; blockIndex: number }> = []
      const flushContent = () => {
        if (content.length === 0) return
        finishTrace()
        ;(turn!.node.flow as TurnFlowNode[]).push({
          kind: "assistant-content",
          id: `${turn!.node.id}:flow:${turn!.node.flow.length}`,
          source: sourceIdentity,
          message,
          blocks: content,
        })
        content = []
      }
      message.content.forEach((block, blockIndex) => {
        if (block.type === "text" || block.type === "image") {
          content.push({ block, blockIndex })
          return
        }
        flushContent()
        if (block.type === "thinking" && !block.deferred && block.thinking.trim() === "") return
        const activeTrace = ensureTrace(priorTimestamp)
        if (activeTrace === null) return
        if (block.type === "thinking") {
          activeTrace.items.push({
            kind: "thinking",
            id: `${activeTrace.node.id}:item:${activeTrace.items.length}`,
            source: sourceIdentity,
            message,
            block,
            blockIndex,
          })
        } else {
          const item: TraceToolItem = {
            kind: "tool",
            id: `${activeTrace.node.id}:item:${activeTrace.items.length}`,
            source: sourceIdentity,
            message,
            block,
            blockIndex,
          }
          activeTrace.items.push(item)
          const queue = turn!.calls.get(block.toolCallId) ?? []
          queue.push(item)
          turn!.calls.set(block.toolCallId, queue)
        }
      })
      flushContent()
      if (message.stopReason === "aborted" || message.errorMessage?.trim()) {
        finishTrace()
        ;(turn.node.flow as TurnFlowNode[]).push({
          kind: "termination",
          id: `${turn.node.id}:flow:${turn.node.flow.length}`,
          source: sourceIdentity,
          reason: message.stopReason === "aborted" ? "aborted" : "error",
          ...(message.errorMessage?.trim() ? { message: message.errorMessage.trim() } : {}),
        })
      }
      continue
    }
    if (message.role === "toolResult") {
      const queue = turn.calls.get(message.toolCallId)
      const call = queue?.find((candidate) => candidate.result === undefined)
      if (call !== undefined) {
        call.result = { source: sourceIdentity, message }
      } else {
        const activeTrace = ensureTrace(priorTimestamp)
        activeTrace?.items.push({
          kind: "unmatched-tool-result",
          id: `${activeTrace.node.id}:item:${activeTrace.items.length}`,
          source: sourceIdentity,
          message,
        })
      }
      const conversationView = conversationViewFromDetails(message.details)
      if (conversationView !== null) {
        finishTrace()
        ;(turn.node.flow as TurnFlowNode[]).push({
          kind: "conversation-view",
          id: `${turn.node.id}:flow:${turn.node.flow.length}`,
          source: sourceIdentity,
          message,
          view: conversationView._tag === "Valid" ? conversationView.view : null,
        })
      }
      continue
    }
    if (message.role === "custom") {
      finishTrace()
      const conversationView = conversationViewFromDetails(message.details)
      ;(turn.node.flow as TurnFlowNode[]).push(
        conversationView === null
          ? {
              kind: "extension-content",
              id: `${turn.node.id}:flow:${turn.node.flow.length}`,
              source: sourceIdentity,
              message,
              collapsed: !message.display,
            }
          : {
              kind: "conversation-view",
              id: `${turn.node.id}:flow:${turn.node.flow.length}`,
              source: sourceIdentity,
              message,
              view: conversationView._tag === "Valid" ? conversationView.view : null,
            },
      )
    }
  }
  finishTurn()
  const previousById = new Map(previous?.nodes.map((node) => [node.id, node]) ?? [])
  const reconciledNodes = nodes.map((node) => {
    const old = previousById.get(node.id)
    if (old === undefined || old.kind !== node.kind) return node
    const currentMessages = nodeMessages.get(node)
    const oldMessages = nodeMessages.get(old)
    if (
      currentMessages === undefined ||
      oldMessages === undefined ||
      currentMessages.length !== oldMessages.length ||
      currentMessages.some((message, index) => message !== oldMessages[index]) ||
      (node.kind === "turn" && old.kind === "turn" && node.status !== old.status) ||
      (node.kind === "user-command" && old.kind === "user-command" && node.status !== old.status)
    )
      return node
    return old
  })
  const turnIndex = reconciledNodes.flatMap((node, nodeIndex): TurnIndexEntry[] =>
    node.kind === "turn"
      ? [{ turnId: node.id, nodeIndex, rowId: node.id, promptPreview: userText(node.user.message) }]
      : [],
  )
  return { nodes: reconciledNodes, turnIndex }
}
