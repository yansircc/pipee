import * as stylex from "@stylexjs/stylex"
import { useState, useCallback, useMemo } from "react"
import type { SessionBranchNode } from "@/api/contract"
import { useI18n } from "@/lib/i18n"
interface Props {
  branchNodes: ReadonlyArray<SessionBranchNode>
  activeLeafId: string | null
  onLeafChange: (leafId: string | null) => void
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean
  /** Controlled open state for inline mode */
  open?: boolean
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean
}
interface BranchOption {
  readonly node: SessionBranchNode
  readonly entryCount: number
}
const branchView = (nodes: ReadonlyArray<SessionBranchNode>) => {
  const byId = new Map(nodes.map((node) => [node.entryId, node]))
  const childCounts = new Map<string, number>()
  for (const node of nodes) {
    if (node.parentNodeId !== null && byId.has(node.parentNodeId)) {
      childCounts.set(node.parentNodeId, (childCounts.get(node.parentNodeId) ?? 0) + 1)
    }
  }
  const entryCount = (leaf: SessionBranchNode): number => {
    let total = 0
    let node: SessionBranchNode | undefined = leaf
    const seen = new Set<string>()
    while (node !== undefined && !seen.has(node.entryId)) {
      seen.add(node.entryId)
      total += node.compressedCount + 1
      node = node.parentNodeId === null ? undefined : byId.get(node.parentNodeId)
    }
    return total
  }
  const options: ReadonlyArray<BranchOption> = nodes
    .filter((node) => node.active || !childCounts.has(node.entryId))
    .map((node) => ({ node, entryCount: entryCount(node) }))
    .toSorted((left, right) => Number(right.node.active) - Number(left.node.active))
  return {
    branchCount: options.length,
    hasBranch: options.length > 1,
    options,
  }
}
interface BranchNodeProps {
  option: BranchOption
  activeLeafId: string | null
  index: number
  last: boolean
  onSelect: (id: string) => void
}
function BranchNodeView({ option, activeLeafId, index, last, onSelect }: BranchNodeProps) {
  const { t } = useI18n()
  const { node, entryCount } = option
  const isActive = node.entryId === activeLeafId || node.active
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={isActive ? "true" : undefined}
      onClick={() => onSelect(node.entryId)}
      {...stylex.props(inlineStyles.branchOption, isActive && inlineStyles.branchOptionActive)}
    >
      <span {...stylex.props(inlineStyles.branchRail)}>
        <span
          {...stylex.props(
            inlineStyles.branchLine,
            index === 0 && inlineStyles.branchLineFirst,
            last && inlineStyles.branchLineLast,
          )}
        />
        {index > 0 && <span {...stylex.props(inlineStyles.branchLineChild)} />}
        <i {...stylex.props(inlineStyles.branchDot, !isActive && inlineStyles.branchDotInactive)} />
      </span>
      <span {...stylex.props(inlineStyles.branchCopy)}>
        <strong {...stylex.props(inlineStyles.branchTitle)}>{isActive ? t("Current branch") : node.label}</strong>
        <small {...stylex.props(inlineStyles.branchMeta)}>
          {t(entryCount === 1 ? "{count} entry" : "{count} entries", { count: entryCount })}
        </small>
      </span>
      {isActive && <em {...stylex.props(inlineStyles.branchCurrent)}>{t("Current")}</em>}
    </button>
  )
}
export function BranchNavigator({
  branchNodes,
  activeLeafId,
  onLeafChange,
  inline,
  open: openProp,
  onToggle,
  hasSession,
  compact,
}: Props) {
  const { t } = useI18n()
  const [openInternal, setOpenInternal] = useState(false)
  const open = openProp !== undefined ? openProp : openInternal
  const view = useMemo(() => branchView(branchNodes), [branchNodes])
  const handleSelect = useCallback(
    (id: string) => {
      onLeafChange(id)
      if (open) (onToggle ?? (() => setOpenInternal(false)))()
    },
    [onLeafChange, onToggle, open],
  )
  const noBranchReason = !hasSession
    ? t("No active session")
    : !view.hasBranch
      ? t("This session has no branches")
      : null
  const hasContent = !noBranchReason && view.options.length > 0
  const branchIcon = (
    <svg
      width={inline ? 11 : 12}
      height={inline ? 17 : 12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={inline ? 1.7 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stylex.props(inlineStyles.inline11)}
      style={{
        color: inline ? "var(--text-muted)" : hasContent ? "var(--accent)" : "var(--text-dim)",
      }}
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 14c5 0 2-7 8-7" />
    </svg>
  )
  const chevron = (
    <svg
      width={inline ? 11 : 10}
      height={inline ? 17 : 10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--text-dim)"
      strokeWidth={inline ? 1.7 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...stylex.props(inlineStyles.inline12)}
      style={{
        marginLeft: inline ? 0 : 2,
        transform: inline ? (open ? "rotate(-90deg)" : "rotate(90deg)") : open ? "rotate(180deg)" : "none",
      }}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
  if (inline) {
    return (
      <div {...stylex.props(inlineStyles.inline13)}>
        <button
          onClick={() => (onToggle ? onToggle() : setOpenInternal((v) => !v))}
          {...stylex.props(inlineStyles.inline14)}
          style={{
            background: open ? "var(--bg-selected)" : "var(--bg-panel)",
            color: open ? "var(--text)" : "var(--text-muted)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"
          }}
          title={t("Branches")}
          aria-label={t("Branches")}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          {branchIcon}
          {!compact && (
            <span>
              {view.branchCount > 0
                ? t(view.branchCount === 1 ? "{count} branch" : "{count} branches", { count: view.branchCount })
                : t("Branches")}
            </span>
          )}
          {!compact && chevron}
        </button>
        {open && (
          <div role="menu" aria-label={t("Session branches")} {...stylex.props(inlineStyles.inline15)}>
            <header {...stylex.props(inlineStyles.branchHeader)}>
              <strong {...stylex.props(inlineStyles.branchHeaderTitle)}>{t("Session branches")}</strong>
              <small {...stylex.props(inlineStyles.branchHeaderCount)}>{view.branchCount}</small>
            </header>
            {hasContent ? (
              <div {...stylex.props(inlineStyles.inline16)}>
                {view.options.map((option, index) => (
                  <BranchNodeView
                    key={option.node.entryId}
                    option={option}
                    activeLeafId={activeLeafId}
                    index={index}
                    last={index === view.options.length - 1}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            ) : (
              <div {...stylex.props(inlineStyles.inline17)}>{noBranchReason}</div>
            )}
            {hasContent && (
              <footer {...stylex.props(inlineStyles.branchFooter)}>{t("Switching stays in this session")}</footer>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <div {...stylex.props(inlineStyles.inline18)}>
      {/* Header toggle */}
      <button onClick={() => setOpenInternal((v) => !v)} {...stylex.props(inlineStyles.inline19)}>
        {branchIcon}
        <span {...stylex.props(inlineStyles.inline20)}>{t("Branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div {...stylex.props(inlineStyles.inline21)}>
          {hasContent ? (
            <div {...stylex.props(inlineStyles.inline22)}>
              {view.options.map((option, index) => (
                <BranchNodeView
                  key={option.node.entryId}
                  option={option}
                  activeLeafId={activeLeafId}
                  index={index}
                  last={index === view.options.length - 1}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          ) : (
            <div {...stylex.props(inlineStyles.inline23)}>{noBranchReason ?? t("This session has no branches")}</div>
          )}
        </div>
      )}
    </div>
  )
}
const reveal = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-4px)" },
  to: { opacity: 1, transform: "translateY(0)" },
})
const inlineStyles = stylex.create({
  branchOption: {
    alignItems: "center",
    background: "transparent",
    border: 0,
    borderRadius: 8,
    cursor: "pointer",
    display: "grid",
    gap: 8,
    gridTemplateColumns: "25px minmax(0, 1fr) auto",
    minHeight: 54,
    padding: "7px 8px",
    textAlign: "left",
    width: "100%",
    ":hover": { background: "var(--bg-subtle)" },
  },
  branchOptionActive: {
    background: "color-mix(in srgb, rgba(34, 197, 94, 0.14) 55%, transparent)",
  },
  branchRail: {
    display: "grid",
    height: 38,
    placeItems: "center",
    position: "relative",
    width: 22,
  },
  branchLine: {
    background: "var(--border)",
    bottom: -7,
    left: 10,
    position: "absolute",
    top: -7,
    width: 1,
  },
  branchLineFirst: {
    top: 18,
  },
  branchLineLast: {
    bottom: 18,
  },
  branchLineChild: {
    background: "var(--border)",
    height: 1,
    left: 10,
    position: "absolute",
    top: 18,
    width: 10,
  },
  branchDot: {
    background: "#16a34a",
    border: "2px solid var(--bg-raised)",
    borderRadius: "50%",
    boxShadow: "0 0 0 1px #16a34a",
    height: 8,
    position: "relative",
    width: 8,
    zIndex: 1,
  },
  branchDotInactive: {
    background: "var(--text-dim)",
    boxShadow: "0 0 0 1px var(--text-dim)",
  },
  branchCopy: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  branchTitle: {
    color: "var(--text)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  branchMeta: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
  },
  branchCurrent: {
    background: "rgba(34, 197, 94, 0.14)",
    borderRadius: 8,
    color: "#16a34a",
    fontSize: 9,
    fontStyle: "normal",
    padding: "2px 6px",
  },
  inline11: {
    flexShrink: 0,
  },
  inline12: {
    marginLeft: 2,
    transition: "transform 0.15s",
  },
  inline13: {
    display: "flex",
    alignItems: "center",
    position: "relative",
  },
  inline14: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    height: 27,
    padding: "0 8px",
    border: "1px solid var(--border)",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 11,
    whiteSpace: "nowrap",
    transition: "color 0.1s, background 0.1s",
  },
  inline15: {
    animationDuration: "130ms",
    animationName: reveal,
    animationTimingFunction: "ease",
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 11,
    boxShadow: "var(--shadow-lg)",
    left: 0,
    padding: 6,
    position: "absolute",
    top: 35,
    width: 310,
    zIndex: 500,
    "@media (max-width: 760px)": {
      left: 7,
      position: "fixed",
      right: 7,
      top: "calc(var(--topbar-height) - 1px)",
      width: "auto",
    },
  },
  inline16: {
    padding: 0,
    maxHeight: 260,
    overflowY: "auto",
  },
  inline17: {
    padding: "10px 16px",
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
  branchHeader: {
    alignItems: "center",
    borderBottom: "1px solid var(--border-soft)",
    display: "flex",
    height: 35,
    justifyContent: "space-between",
    padding: "0 8px",
  },
  branchHeaderTitle: {
    fontSize: 12,
  },
  branchHeaderCount: {
    color: "var(--text-dim)",
    fontSize: 10,
  },
  branchFooter: {
    color: "var(--text-dim)",
    fontSize: 9,
    padding: "7px 8px 3px",
  },
  inline18: {
    borderBottom: "1px solid var(--border)",
    background: "var(--bg)",
    flexShrink: 0,
    position: "relative",
  },
  inline19: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 12px",
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--text-muted)",
    fontSize: 11,
    textAlign: "left",
  },
  inline20: {
    color: "var(--text-muted)",
  },
  inline21: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    background: "var(--bg)",
    borderBottom: "1px solid var(--border)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
    zIndex: 100,
  },
  inline22: {
    padding: "4px 12px 8px 12px",
    maxHeight: 260,
    overflowY: "auto",
  },
  inline23: {
    padding: "10px 16px",
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
})
