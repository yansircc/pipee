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
  it("preserves the anchor's actual viewport offset after rows are prepended", () => {
    expect(
      restoreScrollOffset(
        {
          rowId: "turn-20",
          dataLength: 20,
          viewportTop: 184,
          userScrollGeneration: 4,
        },
        { scrollOffset: 600, viewportTop: 784 },
      ),
    ).toBe(1_200)
  })

  it("is unaffected by virtual-list measurement drift unrelated to the rendered anchor", () => {
    expect(
      restoreScrollOffset(
        {
          rowId: "turn-20",
          dataLength: 20,
          viewportTop: 184,
          userScrollGeneration: 4,
        },
        { scrollOffset: 600, viewportTop: 198 },
      ),
    ).toBe(614)
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
