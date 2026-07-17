import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import { Effect } from "effect"
import type { SessionBranchNode } from "@/api/contract"
import { useI18n } from "@/lib/i18n"
import { BrowserPlatform } from "@/browser/browser-platform"
import { runBrowser } from "@/browser/api-client"

interface Props {
  branchNodes: ReadonlyArray<SessionBranchNode>
  activeLeafId: string | null
  onLeafChange: (leafId: string | null) => void
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>
  /** Controlled open state for inline mode */
  open?: boolean
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean
}

interface BranchRow {
  readonly node: SessionBranchNode
  readonly isLast: boolean
  readonly parentLines: ReadonlyArray<boolean>
}

const branchView = (nodes: ReadonlyArray<SessionBranchNode>) => {
  const byId = new Map(nodes.map((node) => [node.entryId, node]))
  const children = new Map<string | null, Array<SessionBranchNode>>()
  for (const node of nodes) {
    const parentId = node.parentNodeId !== null && byId.has(node.parentNodeId) ? node.parentNodeId : null
    const siblings = children.get(parentId) ?? []
    siblings.push(node)
    children.set(parentId, siblings)
  }
  const hasBranch = [...children.values()].some((siblings) => siblings.length > 1)
  let frontier = children.get(null) ?? []
  while (frontier.length === 1) {
    const next = children.get(frontier[0]?.entryId ?? "") ?? []
    if (next.length !== 1) break
    frontier = next
  }
  const rows: Array<BranchRow> = []
  const seen = new Set<string>()
  const pending = frontier
    .map((node, index) => ({
      node,
      isLast: index === frontier.length - 1,
      parentLines: [] as ReadonlyArray<boolean>,
    }))
    .reverse()
  while (pending.length > 0) {
    const row = pending.pop()
    if (row === undefined || seen.has(row.node.entryId)) continue
    seen.add(row.node.entryId)
    rows.push(row)
    const descendants = children.get(row.node.entryId) ?? []
    pending.push(
      ...descendants.toReversed().map((node, reverseIndex) => ({
        node,
        isLast: reverseIndex === 0,
        parentLines: [...row.parentLines, !row.isLast],
      })),
    )
  }
  return { byId, hasBranch, rows }
}

const activePath = (
  nodes: ReadonlyArray<SessionBranchNode>,
  byId: ReadonlyMap<string, SessionBranchNode>,
  targetId: string | null,
): Set<string> => {
  if (targetId === null) return new Set()
  let node = nodes.find((candidate) => candidate.entryId === targetId) ?? nodes.find((candidate) => candidate.active)
  const path = new Set<string>()
  while (node !== undefined && !path.has(node.entryId)) {
    path.add(node.entryId)
    node = node.parentNodeId === null ? undefined : byId.get(node.parentNodeId)
  }
  return path
}

interface BranchNodeProps {
  row: BranchRow
  activePathIds: Set<string>
  onSelect: (id: string) => void
}

function BranchNodeView({ row, activePathIds, onSelect }: BranchNodeProps) {
  const { node, isLast, parentLines } = row
  const isActive = activePathIds.has(node.entryId)
  const isOnPath = isActive
  const skipped = node.compressedCount
  const role = node.role ?? null

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          cursor: "pointer",
        }}
        onClick={() => onSelect(node.entryId)}
      >
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div
                style={{
                  position: "absolute",
                  left: 7,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: "var(--border)",
                }}
              />
            )}
          </div>
        ))}

        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          <div
            style={{
              position: "absolute",
              left: 7,
              top: 0,
              bottom: isLast ? "50%" : 0,
              width: 1,
              background: "var(--border)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 7,
              top: "50%",
              width: 9,
              height: 1,
              background: "var(--border)",
            }}
          />
        </div>

        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flexShrink: 0,
            background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
            border: isActive ? "none" : "1px solid var(--text-dim)",
            marginRight: 6,
            transition: "background 0.12s",
          }}
        />

        {role && (
          <span
            style={{
              fontSize: 9,
              fontFamily: "var(--font-mono)",
              color: role === "user" ? "var(--accent)" : "var(--text-dim)",
              background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
              border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
              borderRadius: 3,
              padding: "0 4px",
              marginRight: 5,
              flexShrink: 0,
              lineHeight: "16px",
            }}
          >
            {role === "user" ? "U" : "A"}
          </span>
        )}

        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>+{skipped}</span>
        )}

        <span
          style={{
            fontSize: 11,
            color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
            fontWeight: isActive ? 500 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {node.label}
        </span>
      </div>
    </div>
  )
}

export function BranchNavigator({
  branchNodes,
  activeLeafId,
  onLeafChange,
  inline,
  containerRef,
  open: openProp,
  onToggle,
  hasSession,
  compact,
}: Props) {
  const { t } = useI18n()
  const [openInternal, setOpenInternal] = useState(false)
  const open = openProp !== undefined ? openProp : openInternal
  const btnRef = useRef<HTMLButtonElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    if (!open || !inline) return
    const anchor = containerRef?.current ?? btnRef.current
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width })
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.observeResize([anchor], update))), {
      onSuccess: () => undefined,
    })
  }, [open, inline, containerRef])

  const view = useMemo(() => branchView(branchNodes), [branchNodes])
  const activePathIds = useMemo(
    () => activePath(branchNodes, view.byId, activeLeafId),
    [activeLeafId, branchNodes, view.byId],
  )

  const handleSelect = useCallback(
    (id: string) => {
      onLeafChange(id)
    },
    [onLeafChange],
  )

  const noBranchReason = !hasSession
    ? t("No active session")
    : !view.hasBranch
      ? t("This session has no branches")
      : null
  const hasContent = !noBranchReason && view.rows.length > 0

  const branchIcon = (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )

  const chevron = (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="var(--text-dim)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
    >
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  )

  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          ref={btnRef}
          onClick={() => (onToggle ? onToggle() : setOpenInternal((v) => !v))}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"
          }}
          title={t("Branches")}
          aria-label={t("Branches")}
          aria-pressed={open}
        >
          {branchIcon}
          {!compact && <span>{t("Branches")}</span>}
        </button>
        {open && dropdownPos && (
          <div
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border)",
              zIndex: 500,
            }}
          >
            {hasContent ? (
              <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
                {view.rows.map((row) => (
                  <BranchNodeView
                    key={row.node.entryId}
                    row={row}
                    activePathIds={activePathIds}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            ) : (
              <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                {noBranchReason}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}
    >
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
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
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>{t("Branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 100,
          }}
        >
          {hasContent ? (
            <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
              {view.rows.map((row) => (
                <BranchNodeView
                  key={row.node.entryId}
                  row={row}
                  activePathIds={activePathIds}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {noBranchReason ?? t("This session has no branches")}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
