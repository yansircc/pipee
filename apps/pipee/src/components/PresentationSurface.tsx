import type { PresentationDocument, PresentationIcon, PresentationTone } from "@pipee/companion-contracts/presentation"
import { useState } from "react"
import { useI18n } from "@/lib/i18n"
import { PresentationTree } from "./PresentationTree"

function Glyph({ kind }: { readonly kind: PresentationIcon }) {
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

export function PresentationSurface({
  document,
  mode,
}: {
  readonly document: PresentationDocument
  readonly mode: "artifact" | "live"
}) {
  const [expanded, setExpanded] = useState(false)
  const zh = useI18n().locale === "zh-CN"
  if (mode === "artifact") {
    return (
      <article
        className="conversation-view"
        data-presentation={document.title}
        data-presentation-contract={document.contract}
        data-presentation-mode={mode}
        data-tone={document.tone}
      >
        <header className="conversation-view-header">
          <PresentationMark icon={document.icon} tone={document.tone} />
          <div className="conversation-view-label">{document.title}</div>
          {document.status && (
            <span className="conversation-view-badge" data-tone={document.status.tone}>
              {document.status.text}
            </span>
          )}
          <div className="conversation-view-event-mark" aria-hidden="true">
            {zh ? "会话事件" : "Session event"}
          </div>
        </header>
        <div className="conversation-view-content">
          <div className="conversation-view-text is-caption">{document.summary}</div>
          {document.body && <PresentationTree root={document.body} />}
        </div>
      </article>
    )
  }
  const content = (
    <>
      <PresentationMark icon={document.icon} tone={document.tone} />
      <span className="extension-status-copy">
        <span className="extension-status-label">{document.title}</span>
        <span className="extension-status-summary">{document.summary}</span>
      </span>
      {document.status && (
        <span className="extension-status-state" data-tone={document.status.tone}>
          <span aria-hidden="true" />
          {document.status.text}
        </span>
      )}
      {document.body && (
        <svg className="extension-status-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      )}
    </>
  )
  return (
    <section
      className="extension-status-card"
      data-presentation-contract={document.contract}
      data-presentation-mode={mode}
      data-expanded={expanded || undefined}
      data-tone={document.tone}
    >
      {document.body ? (
        <button
          type="button"
          className="extension-status-trigger"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {content}
        </button>
      ) : (
        <div className="extension-status-trigger">{content}</div>
      )}
      {expanded && document.body && (
        <div className="extension-status-details">
          <PresentationTree root={document.body} />
        </div>
      )}
    </section>
  )
}

export function PresentationMark({ icon, tone }: { readonly icon: PresentationIcon; readonly tone: PresentationTone }) {
  return (
    <span className="extension-surface-mark" data-tone={tone}>
      <Glyph kind={icon} />
    </span>
  )
}
