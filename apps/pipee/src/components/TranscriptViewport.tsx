import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LegendList, type LegendListRef, type OnViewableItemsChangedInfo } from "@legendapp/list/react"
import type { ConversationDocument } from "@/lib/conversation-document"
import type { DisclosureState, DisplayRow } from "@/lib/disclosure-projection"
import { projectDisclosure } from "@/lib/disclosure-projection"
import { initialViewportMode, reduceViewportMode, type ViewportMode } from "@/lib/transcript-viewport"
import { ConversationRow } from "./ConversationRow"
import { useI18n } from "@/lib/i18n"

interface Props {
  readonly sessionId: string
  readonly document: ConversationDocument
  readonly disclosure: DisclosureState
  readonly cwd: string
  readonly modelNames: Record<string, string>
  readonly sessionBusy: boolean
  readonly forkingEntryId?: string | null
  readonly hasMoreBefore: boolean
  readonly loadingEarlier: boolean
  readonly onLoadEarlier: () => void
  readonly onOpenFile?: (path: string) => void
  readonly onFork: (entryId: string) => void
  readonly onNavigate: (entryId: string) => void
  readonly onEditContent: (content: string) => void
  readonly onToggleTrace: (traceId: string) => void
  readonly onToggleExtension: (id: string) => void
  readonly onToggleTelemetry: (turnId: string, expanded: boolean) => void
  readonly onActiveTurnChange: (turnId: string | null) => void
  readonly navigatorRequest: { readonly turnId: string; readonly epoch: number } | null
}

const previousAssistantEntries = (document: ConversationDocument): ReadonlyMap<string, string> => {
  const result = new Map<string, string>()
  let previous: string | undefined
  for (const node of document.nodes) {
    if (node.kind !== "turn") continue
    if (previous !== undefined) result.set(node.id, previous)
    for (const flow of node.flow) {
      if (flow.kind === "assistant-content" && flow.source.entryId !== undefined) previous = flow.source.entryId
      if (flow.kind === "agent-trace") {
        for (const item of flow.items) if (item.source.entryId !== undefined) previous = item.source.entryId
      }
    }
  }
  return result
}

export function TranscriptViewport(props: Props) {
  const { t } = useI18n()
  const listRef = useRef<LegendListRef>(null)
  const previousRows = useRef<ReadonlyArray<DisplayRow>>([])
  const rows = useMemo(() => {
    const next = projectDisclosure(props.document, props.disclosure, previousRows.current)
    previousRows.current = next
    return next
  }, [props.disclosure, props.document])
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows])
  const previousEntries = useMemo(() => previousAssistantEntries(props.document), [props.document])
  const [mode, setMode] = useState<ViewportMode>(initialViewportMode)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const lastScrollY = useRef(0)
  const previousLastTurnId = useRef<string | null>(null)

  useEffect(() => {
    setMode(reduceViewportMode(modeRef.current, { kind: "session-reset" }))
    previousRows.current = []
    previousLastTurnId.current = null
  }, [props.sessionId])

  useEffect(() => {
    const turnId = props.document.turnIndex.at(-1)?.turnId ?? null
    const previous = previousLastTurnId.current
    previousLastTurnId.current = turnId
    if (turnId === null || previous === null || turnId === previous || modeRef.current.kind !== "following-end") return
    const index = rowIndex.get(turnId)
    if (index === undefined) return
    setMode(reduceViewportMode(modeRef.current, { kind: "new-turn", turnId, viewportOffset: 0 }))
    void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 })
  }, [props.document.turnIndex, rowIndex])

  useEffect(() => {
    if (props.navigatorRequest === null) return
    const index = rowIndex.get(props.navigatorRequest.turnId)
    if (index === undefined) return
    setMode(reduceViewportMode(modeRef.current, { kind: "jump-to-turn" }))
    void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 })
  }, [props.navigatorRequest, rowIndex])

  useEffect(() => {
    const current = modeRef.current
    if (current.kind !== "anchoring-turn") return
    const scroll = listRef.current?.getScrollableNode()
    if (!(scroll instanceof HTMLElement)) return
    const first = scroll.querySelector<HTMLElement>(`[data-turn-id='${CSS.escape(current.turnId)}']`)
    if (first === null) return
    const turnRows = rows.filter((row) =>
      row.kind === "turn-user" ? row.id === current.turnId : "turnId" in row && row.turnId === current.turnId,
    )
    const last = scroll.querySelector<HTMLElement>(
      `[data-transcript-row='${CSS.escape(turnRows.at(-1)?.id ?? current.turnId)}']`,
    )
    if (last === null) return
    const viewport = scroll.getBoundingClientRect()
    const prompt = first.getBoundingClientRect()
    const tail = last.getBoundingClientRect()
    if (tail.bottom <= viewport.bottom || prompt.top > viewport.top + current.viewportOffset + 1) return
    scroll.scrollTop += Math.min(tail.bottom - viewport.bottom, Math.max(0, tail.bottom - prompt.top - viewport.height))
  }, [rows])

  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number }
        contentSize: { height: number }
        layoutMeasurement: { height: number }
      }
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      const direction = contentOffset.y < lastScrollY.current ? "up" : "down"
      lastScrollY.current = contentOffset.y
      const atEnd = contentSize.height - contentOffset.y - layoutMeasurement.height <= 48
      const next = reduceViewportMode(modeRef.current, { kind: "user-scroll", direction, atEnd })
      if (next.kind !== modeRef.current.kind) setMode(next)
    },
    [],
  )

  const onActiveTurnChange = props.onActiveTurnChange
  const onViewableItemsChanged = useCallback(
    (info: OnViewableItemsChangedInfo<DisplayRow>) => {
      const first = info.viewableItems.find((token) => token.isViewable)?.item
      if (first === undefined) return
      const index = rows.findIndex((row) => row.id === first.id)
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const row = rows[cursor]
        if (row.kind === "turn-user") {
          onActiveTurnChange(row.id)
          return
        }
      }
      onActiveTurnChange(null)
    },
    [onActiveTurnChange, rows],
  )

  const scrollToLatest = () => {
    setMode(reduceViewportMode(modeRef.current, { kind: "scroll-to-latest" }))
    void listRef.current?.scrollToEnd({ animated: true })
  }

  return (
    <div className="transcript-viewport" data-viewport-mode={mode.kind}>
      <LegendList
        data-testid="chat-scroll-container"
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        estimatedItemSize={92}
        initialScrollIndex={Math.max(0, rows.length - 1)}
        recycleItems
        extraData={props.disclosure}
        maintainVisibleContentPosition={{ data: true }}
        maintainScrollAtEnd={mode.kind === "following-end"}
        maintainScrollAtEndThreshold={0.1}
        onScroll={onScroll}
        onViewableItemsChanged={onViewableItemsChanged}
        ListHeaderComponent={
          props.hasMoreBefore ? (
            <div className="load-earlier-row">
              <button type="button" disabled={props.loadingEarlier} onClick={props.onLoadEarlier}>
                {props.loadingEarlier ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          ) : null
        }
        renderItem={({ item }) => (
          <ConversationRow
            row={item}
            sessionId={props.sessionId}
            cwd={props.cwd}
            modelNames={props.modelNames}
            sessionBusy={props.sessionBusy}
            forkingEntryId={props.forkingEntryId}
            previousAssistantEntryId={item.kind === "turn-user" ? previousEntries.get(item.id) : undefined}
            onOpenFile={props.onOpenFile}
            onFork={props.onFork}
            onNavigate={props.onNavigate}
            onEditContent={props.onEditContent}
            onToggleTrace={props.onToggleTrace}
            onToggleExtension={props.onToggleExtension}
            onToggleTelemetry={props.onToggleTelemetry}
          />
        )}
      />
      {mode.kind !== "following-end" && (
        <button type="button" className="scroll-to-latest" onClick={scrollToLatest}>
          ↓ {t("Scroll to latest")}
        </button>
      )}
    </div>
  )
}
