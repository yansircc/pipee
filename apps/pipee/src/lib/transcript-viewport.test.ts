import { describe, expect, it } from "vitest"
import {
  initialViewportMode,
  isViewportNavigationGesture,
  reduceViewportMode,
  restoreScrollOffset,
} from "./transcript-viewport"

describe("isViewportNavigationGesture", () => {
  it("separates scrolling gestures from pointer activation inside a row", () => {
    expect(isViewportNavigationGesture("wheel", false)).toBe(true)
    expect(isViewportNavigationGesture("touchmove", false)).toBe(true)
    expect(isViewportNavigationGesture("pointerdown", true)).toBe(true)
    expect(isViewportNavigationGesture("pointerdown", false)).toBe(false)
  })
})

describe("restoreScrollOffset", () => {
  it("preserves the anchor's logical viewport offset after rows are prepended", () => {
    expect(
      restoreScrollOffset(
        {
          rowId: "turn-20",
          dataLength: 20,
          rowPosition: 640,
          headerSize: 40,
          scrollOffset: 600,
          userScrollGeneration: 4,
        },
        { rowPosition: 1_240, headerSize: 40 },
      ),
    ).toBe(1_200)
  })

  it("includes changes to the list header's logical leading inset", () => {
    expect(
      restoreScrollOffset(
        {
          rowId: "turn-20",
          dataLength: 20,
          rowPosition: 640,
          headerSize: 40,
          scrollOffset: 600,
          userScrollGeneration: 4,
        },
        { rowPosition: 1_240, headerSize: 54 },
      ),
    ).toBe(1_214)
  })
})

describe("reduceViewportMode", () => {
  it("keeps following new turns until the user scrolls away", () => {
    const following = reduceViewportMode(initialViewportMode, { kind: "new-turn", turnId: "t", viewportOffset: 12 })
    expect(following).toEqual(initialViewportMode)
    const free = reduceViewportMode(following, { kind: "user-scroll", direction: "up", atEnd: false })
    expect(reduceViewportMode(free, { kind: "new-turn", turnId: "next", viewportOffset: 12 })).toBe(free)
  })
  it("returns to following only by reaching or requesting the end", () => {
    const free = { kind: "free-scrolling" } as const
    expect(reduceViewportMode(free, { kind: "user-scroll", direction: "down", atEnd: true })).toEqual(
      initialViewportMode,
    )
    expect(reduceViewportMode(free, { kind: "scroll-to-latest" })).toEqual(initialViewportMode)
  })
})
