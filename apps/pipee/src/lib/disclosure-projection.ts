import type {
  AgentTraceNode,
  ConversationDocument,
  DocumentNode,
  TurnFlowNode,
  TurnNode,
} from "./conversation-document"

export interface DisclosureState {
  readonly expandedTraceIds: ReadonlySet<string>
  readonly expandedExtensionIds: ReadonlySet<string>
  readonly expandedTelemetryTurnIds: ReadonlySet<string>
}

export const emptyDisclosureState = (): DisclosureState => ({
  expandedTraceIds: new Set(),
  expandedExtensionIds: new Set(),
  expandedTelemetryTurnIds: new Set(),
})

export type DisplayRow =
  | { readonly kind: "turn-user"; readonly id: string; readonly turn: TurnNode }
  | {
      readonly kind: "assistant-content"
      readonly id: string
      readonly turnId: string
      readonly node: Extract<TurnFlowNode, { kind: "assistant-content" }>
    }
  | {
      readonly kind: "agent-trace"
      readonly id: string
      readonly turnId: string
      readonly node: AgentTraceNode
      readonly expanded: boolean
      readonly summary: string
      readonly visibleItems: AgentTraceNode["items"]
      readonly actionCount: number
    }
  | {
      readonly kind: "extension-content"
      readonly id: string
      readonly turnId?: string
      readonly node:
        | Extract<TurnFlowNode, { kind: "extension-content" }>
        | Extract<DocumentNode, { kind: "extension-entry" }>
      readonly expanded: boolean
    }
  | {
      readonly kind: "conversation-view"
      readonly id: string
      readonly turnId?: string
      readonly node: Extract<TurnFlowNode | DocumentNode, { kind: "conversation-view" }>
    }
  | {
      readonly kind: "termination"
      readonly id: string
      readonly turnId: string
      readonly node: Extract<TurnFlowNode, { kind: "termination" }>
    }
  | { readonly kind: "turn-telemetry"; readonly id: string; readonly turn: TurnNode; readonly expanded: boolean }
  | {
      readonly kind: "user-command"
      readonly id: string
      readonly node: Extract<DocumentNode, { kind: "user-command" }>
    }
  | {
      readonly kind: "context-boundary"
      readonly id: string
      readonly node: Extract<DocumentNode, { kind: "context-boundary" }>
    }
  | {
      readonly kind: "orphan-message"
      readonly id: string
      readonly node: Extract<DocumentNode, { kind: "orphan-message" }>
    }

const traceSummary = (trace: AgentTraceNode, actionCount: number): string => {
  if (trace.status === "running") {
    const current = trace.items.at(-1)
    if (current?.kind === "tool") return `Running ${current.block.toolName}`
    if (current?.kind === "thinking") return "Thinking"
    return "Working"
  }
  const duration =
    trace.startedAt !== undefined && trace.endedAt !== undefined && trace.endedAt >= trace.startedAt
      ? Math.round((trace.endedAt - trace.startedAt) / 1_000)
      : null
  return `${duration === null ? "Worked" : `Worked for ${duration}s`} · ${actionCount} ${actionCount === 1 ? "action" : "actions"}`
}

const sameRow = (left: DisplayRow, right: DisplayRow): boolean => {
  if (left.kind !== right.kind || left.id !== right.id) return false
  if (left.kind === "turn-user" && right.kind === "turn-user") return left.turn === right.turn
  if (left.kind === "assistant-content" && right.kind === "assistant-content") return left.node === right.node
  if (left.kind === "agent-trace" && right.kind === "agent-trace")
    return left.node === right.node && left.expanded === right.expanded
  if (left.kind === "extension-content" && right.kind === "extension-content")
    return left.node === right.node && left.expanded === right.expanded
  if (left.kind === "conversation-view" && right.kind === "conversation-view") return left.node === right.node
  if (left.kind === "termination" && right.kind === "termination") return left.node === right.node
  if (left.kind === "turn-telemetry" && right.kind === "turn-telemetry")
    return left.turn === right.turn && left.expanded === right.expanded
  if (left.kind === "user-command" && right.kind === "user-command") return left.node === right.node
  if (left.kind === "context-boundary" && right.kind === "context-boundary") return left.node === right.node
  return left.kind === "orphan-message" && right.kind === "orphan-message" && left.node === right.node
}

export function projectDisclosure(
  document: ConversationDocument,
  state: DisclosureState,
  previous: ReadonlyArray<DisplayRow> = [],
): ReadonlyArray<DisplayRow> {
  const rows: DisplayRow[] = []
  const pushTurn = (turn: TurnNode) => {
    rows.push({ kind: "turn-user", id: turn.id, turn })
    for (const node of turn.flow) {
      if (node.kind === "assistant-content") {
        rows.push({ kind: "assistant-content", id: node.id, turnId: turn.id, node })
      } else if (node.kind === "agent-trace") {
        const expanded = state.expandedTraceIds.has(node.id)
        const actionCount = node.items.filter((item) => item.kind === "thinking" || item.kind === "tool").length
        rows.push({
          kind: "agent-trace",
          id: node.id,
          turnId: turn.id,
          node,
          expanded,
          summary: traceSummary(node, actionCount),
          visibleItems: expanded ? node.items : node.status === "running" ? node.items.slice(-1) : [],
          actionCount,
        })
      } else if (node.kind === "extension-content") {
        rows.push({
          kind: "extension-content",
          id: node.id,
          turnId: turn.id,
          node,
          expanded: !node.collapsed || state.expandedExtensionIds.has(node.id),
        })
      } else if (node.kind === "conversation-view") {
        rows.push({ kind: "conversation-view", id: node.id, turnId: turn.id, node })
      } else {
        rows.push({ kind: "termination", id: node.id, turnId: turn.id, node })
      }
    }
    if (turn.telemetry !== null || turn.status === "running") {
      rows.push({
        kind: "turn-telemetry",
        id: `${turn.id}:telemetry`,
        turn,
        expanded: state.expandedTelemetryTurnIds.has(turn.id),
      })
    }
  }
  for (const node of document.nodes) {
    if (node.kind === "turn") pushTurn(node)
    else if (node.kind === "user-command") rows.push({ kind: "user-command", id: node.id, node })
    else if (node.kind === "context-boundary") rows.push({ kind: "context-boundary", id: node.id, node })
    else if (node.kind === "conversation-view") rows.push({ kind: "conversation-view", id: node.id, node })
    else if (node.kind === "extension-entry") {
      rows.push({
        kind: "extension-content",
        id: node.id,
        node,
        expanded: !node.collapsed || state.expandedExtensionIds.has(node.id),
      })
    } else rows.push({ kind: "orphan-message", id: node.id, node })
  }

  const previousById = new Map(previous.map((row) => [row.id, row]))
  return rows.map((row) => {
    const old = previousById.get(row.id)
    return old !== undefined && sameRow(old, row) ? old : row
  })
}
