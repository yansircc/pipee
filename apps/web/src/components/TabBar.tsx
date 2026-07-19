import * as stylex from "@stylexjs/stylex"
import { useState } from "react"
import { getFileIcon } from "./FileIcons"
import { useI18n } from "@/lib/i18n"
export interface Tab {
  id: string
  label: string
  filePath: string
  sourceSessionId?: string | null
}
interface Props {
  tabs: Tab[]
  activeTabId: string
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
}
export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n()
  const [hoveredClose, setHoveredClose] = useState<string | null>(null)
  return (
    <div {...stylex.props(inlineStyles.inline1)}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            {...stylex.props(inlineStyles.inline2)}
            style={{
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              color: isActive ? "var(--text)" : "var(--text-muted)",
            }}
          >
            <span
              {...stylex.props(inlineStyles.inline3)}
              style={{
                opacity: isActive ? 1 : 0.7,
              }}
            >
              {getFileIcon(tab.label, 13)}
            </span>
            <span
              {...stylex.props(inlineStyles.inline4)}
              style={{
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              {...stylex.props(inlineStyles.inline5)}
              style={{
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
              }}
              title={t("Close")}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    display: "flex",
    alignItems: "flex-end",
    background: "var(--bg-panel)",
    overflowX: "auto",
    flexShrink: 0,
    height: 36,
  },
  inline2: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingLeft: 12,
    paddingRight: 6,
    borderRight: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap",
    maxWidth: 180,
    minWidth: 80,
    flexShrink: 0,
    userSelect: "none",
    transition: "background 0.1s, color 0.1s",
  },
  inline3: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  inline4: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  },
  inline5: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    border: "none",
    borderRadius: 3,
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
    transition: "background 0.1s, color 0.1s",
  },
})
