import type { ConversationViewNode } from "@pipee/companion-contracts/conversation-view"

const NodeView = ({ node, path }: { readonly node: ConversationViewNode; readonly path: string }) => {
  if (node.type === "group") {
    return (
      <div className={`conversation-view-group is-${node.direction} gap-${node.gap}`}>
        {node.children.map((child, index) => (
          <NodeView key={`${path}:${index}`} node={child} path={`${path}:${index}`} />
        ))}
      </div>
    )
  }
  if (node.type === "text") {
    return (
      <div className={`conversation-view-text is-${node.variant}`} data-tone={node.tone}>
        {node.text}
      </div>
    )
  }
  if (node.type === "badge") {
    return (
      <span className="conversation-view-badge" data-tone={node.tone}>
        {node.text}
      </span>
    )
  }
  if (node.type === "field") {
    return (
      <dl className="conversation-view-field">
        <dt>{node.label}</dt>
        <dd>{node.value}</dd>
      </dl>
    )
  }
  return (
    <div className="conversation-view-progress">
      {node.label && <span>{node.label}</span>}
      <progress value={node.value} max={1} aria-label={node.label ?? "Progress"} />
    </div>
  )
}

export function ConversationViewTree({ root }: { readonly root: ConversationViewNode }) {
  return <NodeView node={root} path="root" />
}
