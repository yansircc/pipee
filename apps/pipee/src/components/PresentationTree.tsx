import type { PresentationNode } from "@pipee/companion-contracts/presentation"

const NodeView = ({ node, path }: { readonly node: PresentationNode; readonly path: string }) => {
  if (node.type === "group") {
    return (
      <div className={`presentation-tree-group is-${node.direction} gap-${node.gap}`}>
        {node.children.map((child, index) => (
          <NodeView key={`${path}:${index}`} node={child} path={`${path}:${index}`} />
        ))}
      </div>
    )
  }
  if (node.type === "text") {
    return (
      <div className={`presentation-tree-text is-${node.variant}`} data-tone={node.tone}>
        {node.text}
      </div>
    )
  }
  if (node.type === "badge") {
    return (
      <span className="presentation-tree-badge" data-tone={node.tone}>
        {node.text}
      </span>
    )
  }
  if (node.type === "field") {
    return (
      <dl className="presentation-tree-field">
        <dt>{node.label}</dt>
        <dd>{node.value}</dd>
      </dl>
    )
  }
  return (
    <div className="presentation-tree-progress">
      {node.label && <span>{node.label}</span>}
      <progress value={node.value} max={1} aria-label={node.label ?? "Progress"} />
    </div>
  )
}

export function PresentationTree({ root }: { readonly root: PresentationNode }) {
  return (
    <div className="presentation-tree">
      <NodeView node={root} path="root" />
    </div>
  )
}
