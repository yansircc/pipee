import type { ConversationDocument } from "@/lib/conversation-document"

export function TurnNavigator({
  document,
  activeTurnId,
  onNavigate,
}: {
  readonly document: ConversationDocument
  readonly activeTurnId: string | null
  readonly onNavigate: (rowId: string) => void
}) {
  const turns = new Map(document.turnIndex.map((entry) => [entry.nodeIndex, entry]))
  const items: Array<{ kind: "turn" | "boundary"; id: string; label: string }> = []
  document.nodes.forEach((node, nodeIndex) => {
    const turn = turns.get(nodeIndex)
    if (turn !== undefined) items.push({ kind: "turn", id: turn.turnId, label: turn.promptPreview || "Empty prompt" })
    else if (node.kind === "context-boundary") items.push({ kind: "boundary", id: node.id, label: "Context compacted" })
  })
  if (items.length === 0) return null
  return (
    <nav className="turn-navigator" aria-label="Conversation turns">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`turn-navigator-item ${item.kind}`}
          title={item.label}
          aria-label={item.label}
          aria-current={item.kind === "turn" && item.id === activeTurnId ? "true" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </nav>
  )
}
