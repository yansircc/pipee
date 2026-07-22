import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { LegendList, type LegendListRef, type OnViewableItemsChangedInfo } from "@legendapp/list/react"
import { Effect } from "effect"
import type { ConversationDocument } from "@/lib/conversation-document"
import type { DisclosureState, DisplayRow } from "@/lib/disclosure-projection"
import { projectDisclosure } from "@/lib/disclosure-projection"
import {
  initialViewportMode,
  isViewportNavigationGesture,
  reduceViewportMode,
  restoreScrollOffset,
  type LogicalViewportAnchor,
  type ViewportMode,
} from "@/lib/transcript-viewport"
import { ConversationRow } from "./ConversationRow"
import { useI18n } from "@/lib/i18n"
import { runBrowser, type Cancel } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"

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

const afterLayoutSettles = BrowserPlatform.pipe(
  Effect.flatMap((browser) => browser.nextAnimationFrame.pipe(Effect.andThen(browser.nextAnimationFrame))),
)

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
  const commitMode = useCallback((next: ViewportMode) => {
    modeRef.current = next
    setMode(next)
  }, [])
  const userScrollGeneration = useRef(0)
  const liveFollowGeneration = useRef<number | null>(0)
  const liveFollowFrame = useRef<Cancel | null>(null)
  const previousLastTurnId = useRef<string | null>(null)
  const currentViewportAnchor = useRef<LogicalViewportAnchor | null>(null)
  const pendingPrependAnchor = useRef<LogicalViewportAnchor | null>(null)
  const headerSize = useRef(0)
  const restorePrependAnchor = useRef<Cancel | null>(null)
  const cancelLiveFollowForUserNavigation = useCallback(() => {
    userScrollGeneration.current += 1
    liveFollowGeneration.current = null
    liveFollowFrame.current?.()
    liveFollowFrame.current = null
    pendingPrependAnchor.current = null
    restorePrependAnchor.current?.()
    restorePrependAnchor.current = null
    commitMode({ kind: "free-scrolling" })
  }, [commitMode])
  const readViewportAnchor = useCallback((): LogicalViewportAnchor | null => {
    const list = listRef.current
    const state = list?.getState()
    const scroll = listRef.current?.getScrollableNode()
    if (!state || !(scroll instanceof HTMLElement)) return null
    const viewport = scroll.getBoundingClientRect()
    const row = [...scroll.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewport.top,
    )
    if (row?.dataset.transcriptRow === undefined) return null
    const rowId = row.dataset.transcriptRow
    const index = state.data.findIndex((candidate) => (candidate as DisplayRow).id === rowId)
    if (index < 0) return null
    const rowPosition = state.positionAtIndex(index)
    if (!Number.isFinite(rowPosition) || !Number.isFinite(state.scroll)) return null
    return {
      rowId,
      dataLength: state.data.length,
      rowPosition,
      headerSize: headerSize.current,
      scrollOffset: state.scroll,
      userScrollGeneration: userScrollGeneration.current,
    }
  }, [])
  useEffect(
    () => () => {
      liveFollowFrame.current?.()
      restorePrependAnchor.current?.()
    },
    [],
  )

  useEffect(() => {
    userScrollGeneration.current += 1
    liveFollowGeneration.current = userScrollGeneration.current
    liveFollowFrame.current?.()
    liveFollowFrame.current = null
    restorePrependAnchor.current?.()
    restorePrependAnchor.current = null
    commitMode(initialViewportMode)
    previousRows.current = []
    previousLastTurnId.current = null
    currentViewportAnchor.current = null
    pendingPrependAnchor.current = null
  }, [commitMode, props.sessionId])

  useEffect(() => {
    const cancel = runBrowser(
      afterLayoutSettles.pipe(
        Effect.flatMap(() => {
          const scroll = listRef.current?.getScrollableNode()
          if (!(scroll instanceof HTMLElement)) return Effect.never
          const handleUserNavigation = (event: Event) => {
            if (event.target instanceof Element && event.target.closest("[data-prepend-anchor-control]")) return
            if (
              (event.type === "wheel" || event.type === "touchmove" || event.type === "pointerdown") &&
              !isViewportNavigationGesture(event.type, event.target === scroll)
            )
              return
            cancelLiveFollowForUserNavigation()
          }
          return Effect.scoped(
            Effect.acquireRelease(
              Effect.sync(() => {
                scroll.addEventListener("wheel", handleUserNavigation, { passive: true })
                scroll.addEventListener("touchmove", handleUserNavigation, { passive: true })
                scroll.addEventListener("pointerdown", handleUserNavigation, { passive: true })
              }),
              () =>
                Effect.sync(() => {
                  scroll.removeEventListener("wheel", handleUserNavigation)
                  scroll.removeEventListener("touchmove", handleUserNavigation)
                  scroll.removeEventListener("pointerdown", handleUserNavigation)
                }),
            ).pipe(Effect.andThen(Effect.never)),
          )
        }),
      ),
      { onSuccess: () => undefined },
    )
    return cancel
  }, [cancelLiveFollowForUserNavigation, props.sessionId])

  useEffect(() => {
    const turnId = props.document.turnIndex.at(-1)?.turnId ?? null
    const previous = previousLastTurnId.current
    previousLastTurnId.current = turnId
    if (turnId === null || previous === null || turnId === previous || modeRef.current.kind !== "following-end") return
    commitMode(reduceViewportMode(modeRef.current, { kind: "new-turn", turnId, viewportOffset: 0 }))
  }, [commitMode, props.document.turnIndex])

  useEffect(() => {
    const generation = liveFollowGeneration.current
    if (generation === null) return
    liveFollowFrame.current?.()
    const cancel = runBrowser(
      afterLayoutSettles.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              generation !== userScrollGeneration.current ||
              liveFollowGeneration.current !== generation ||
              modeRef.current.kind !== "following-end"
            )
              return
            void listRef.current?.scrollToEnd({ animated: false })
          }),
        ),
      ),
      { onSuccess: () => undefined },
    )
    liveFollowFrame.current = cancel
    return cancel
  }, [rows])

  useEffect(() => {
    const anchor = pendingPrependAnchor.current
    if (anchor === null) return
    restorePrependAnchor.current?.()
    restorePrependAnchor.current = runBrowser(
      Effect.gen(function* () {
        let settledMeasurements = 0
        let previousTarget: number | null = null
        while (anchor.userScrollGeneration === userScrollGeneration.current) {
          yield* afterLayoutSettles
          const settled = yield* Effect.sync(() => {
            const list = listRef.current
            const state = list?.getState()
            if (!list || !state) return false
            if (state.data.length <= anchor.dataLength) return false
            const index = state.data.findIndex((candidate) => (candidate as DisplayRow).id === anchor.rowId)
            if (index < 0) return false
            const nextRowPosition = state.positionAtIndex(index)
            if (!Number.isFinite(nextRowPosition) || !Number.isFinite(state.scroll)) return false
            const target = restoreScrollOffset(anchor, {
              rowPosition: nextRowPosition,
              headerSize: headerSize.current,
            })
            const measurementStable = previousTarget !== null && Math.abs(target - previousTarget) <= 1
            const scrollStable = Math.abs(state.scroll - target) <= 1
            previousTarget = target
            if (measurementStable && scrollStable) {
              settledMeasurements += 1
              return settledMeasurements >= 2
            }
            settledMeasurements = 0
            void list.scrollToOffset({ offset: target, animated: false })
            return false
          })
          if (!settled) continue
          pendingPrependAnchor.current = null
          currentViewportAnchor.current = readViewportAnchor()
          restorePrependAnchor.current = null
          return
        }
      }),
      { onSuccess: () => undefined },
    )
  }, [readViewportAnchor, rows])

  useEffect(() => {
    if (props.navigatorRequest === null) return
    const index = rowIndex.get(props.navigatorRequest.turnId)
    if (index === undefined) return
    cancelLiveFollowForUserNavigation()
    void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 })
  }, [cancelLiveFollowForUserNavigation, props.navigatorRequest, rowIndex])

  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number }
        contentSize: { height: number }
        layoutMeasurement: { height: number }
      }
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      const atEnd = contentSize.height - contentOffset.y - layoutMeasurement.height <= 48
      if (atEnd && modeRef.current.kind !== "following-end") {
        liveFollowGeneration.current = userScrollGeneration.current
        commitMode(initialViewportMode)
        currentViewportAnchor.current = null
        return
      }
      if (!atEnd) currentViewportAnchor.current = readViewportAnchor()
    },
    [commitMode, readViewportAnchor],
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
    restorePrependAnchor.current?.()
    restorePrependAnchor.current = null
    pendingPrependAnchor.current = null
    liveFollowGeneration.current = userScrollGeneration.current
    commitMode(initialViewportMode)
    void listRef.current?.scrollToEnd({ animated: true })
  }

  const loadEarlier = () => {
    pendingPrependAnchor.current = currentViewportAnchor.current ?? readViewportAnchor()
    props.onLoadEarlier()
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
        maintainVisibleContentPosition={{ data: true, size: false }}
        maintainScrollAtEnd={{
          animated: false,
          on: { dataChange: true, itemLayout: true, layout: true },
        }}
        onMetricsChange={(metrics) => {
          headerSize.current = metrics.headerSize
        }}
        onItemSizeChanged={() => {
          if (modeRef.current.kind === "free-scrolling" && pendingPrependAnchor.current === null) {
            currentViewportAnchor.current = readViewportAnchor()
          }
        }}
        onScroll={onScroll}
        onViewableItemsChanged={onViewableItemsChanged}
        ListHeaderComponent={
          props.hasMoreBefore ? (
            <div className="load-earlier-row">
              <button type="button" data-prepend-anchor-control disabled={props.loadingEarlier} onClick={loadEarlier}>
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
