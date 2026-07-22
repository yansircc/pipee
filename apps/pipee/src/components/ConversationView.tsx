import type { ConversationView as ConversationViewValue } from "@pipee/companion-contracts/conversation-view"
import { useI18n } from "@/lib/i18n"
import { ExtensionSurfaceMark } from "./ExtensionSurface"
import { ConversationViewTree } from "./ConversationViewTree"

export function ConversationView({ view }: { readonly view: ConversationViewValue }) {
  const zh = useI18n().locale === "zh-CN"
  return (
    <article className="conversation-view" data-conversation-view={view.label} data-tone={view.tone}>
      <header className="conversation-view-header">
        <ExtensionSurfaceMark glyph="event" tone={view.tone} />
        <div className="conversation-view-label">{view.label}</div>
        <div className="conversation-view-event-mark" aria-hidden="true">
          {zh ? "会话事件" : "Session event"}
        </div>
      </header>
      <div className="conversation-view-content">
        <ConversationViewTree root={view.root} />
      </div>
    </article>
  )
}
