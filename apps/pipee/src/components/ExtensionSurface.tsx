import type { CompanionView } from "@pipee/companion-contracts/companion-view"
import { useState, type ReactNode } from "react"
import { ConversationViewTree } from "./ConversationViewTree"

export type ExtensionSurfaceTone = "neutral" | "info" | "success" | "warning" | "danger"
export type ExtensionSurfaceGlyph = "automation" | "messages" | "browser" | "extension" | "event"

function Glyph({ kind }: { readonly kind: ExtensionSurfaceGlyph }) {
  if (kind === "automation") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="6.25" />
        <path d="M10 6.5v3.8l2.65 1.5" />
      </svg>
    )
  }
  if (kind === "messages") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.2 5.1c-3 0-5.35 1.82-5.35 4.14 0 1.3.75 2.46 1.94 3.22l-.5 1.75 1.96-1.03c.62.17 1.28.25 1.95.25 3 0 5.35-1.84 5.35-4.2S11.2 5.1 8.2 5.1Z" />
        <path d="M10.8 13.1c.74 1.06 2.08 1.77 3.62 1.77.52 0 1.03-.08 1.5-.23l1.5.8-.4-1.4c.78-.61 1.27-1.48 1.27-2.44 0-1.83-1.75-3.27-4-3.27-.3 0-.58.02-.86.07" />
      </svg>
    )
  }
  if (kind === "browser") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.75" y="4" width="14.5" height="12" rx="2.25" />
        <path d="M3 7.4h14" />
        <path d="M5.2 5.7h.1M7.2 5.7h.1" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m10 2.8 2.15 4.38L17 9.32l-4.85 2.15L10 16.2l-2.15-4.73L3 9.32l4.85-2.14L10 2.8Z" />
    </svg>
  )
}

export function CompanionViewSurface({ renderer, view }: { readonly renderer: string; readonly view: CompanionView }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <ExtensionStatusCard
      renderer={renderer}
      glyph={view.glyph}
      tone={view.tone}
      label={view.label}
      state={view.state}
      summary={view.summary}
      expanded={expanded}
      onToggle={view.details === undefined ? undefined : () => setExpanded((value) => !value)}
    >
      {view.details && <ConversationViewTree root={view.details} />}
    </ExtensionStatusCard>
  )
}

export function ExtensionSurfaceMark({
  glyph,
  tone,
}: {
  readonly glyph: ExtensionSurfaceGlyph
  readonly tone: ExtensionSurfaceTone
}) {
  return (
    <span className="extension-surface-mark" data-tone={tone}>
      <Glyph kind={glyph} />
    </span>
  )
}

export function ExtensionStatusCard({
  renderer,
  glyph,
  tone,
  label,
  state,
  summary,
  expanded = false,
  onToggle,
  children,
}: {
  readonly renderer: string
  readonly glyph: ExtensionSurfaceGlyph
  readonly tone: ExtensionSurfaceTone
  readonly label: string
  readonly state: string
  readonly summary: string
  readonly expanded?: boolean
  readonly onToggle?: () => void
  readonly children?: ReactNode
}) {
  const content = (
    <>
      <ExtensionSurfaceMark glyph={glyph} tone={tone} />
      <span className="extension-status-copy">
        <span className="extension-status-label">{label}</span>
        <span className="extension-status-summary">{summary}</span>
      </span>
      <span className="extension-status-state" data-tone={tone}>
        <span aria-hidden="true" />
        {state}
      </span>
      {onToggle && (
        <svg className="extension-status-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      )}
    </>
  )

  return (
    <section
      className="extension-status-card"
      data-companion-renderer={renderer}
      data-expanded={expanded || undefined}
      data-tone={tone}
    >
      {onToggle ? (
        <button type="button" className="extension-status-trigger" aria-expanded={expanded} onClick={onToggle}>
          {content}
        </button>
      ) : (
        <div className="extension-status-trigger">{content}</div>
      )}
      {expanded && children && <div className="extension-status-details">{children}</div>}
    </section>
  )
}
