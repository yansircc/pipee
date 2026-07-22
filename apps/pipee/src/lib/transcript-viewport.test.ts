import { describe, expect, it } from "vitest"
import { initialViewportMode, reduceViewportMode } from "./transcript-viewport"

describe("reduceViewportMode", () => {
  it("anchors new turns only while following and never steals free scroll", () => {
    const anchored = reduceViewportMode(initialViewportMode, { kind: "new-turn", turnId: "t", viewportOffset: 12 })
    expect(anchored).toEqual({ kind: "anchoring-turn", turnId: "t", viewportOffset: 12 })
    const free = reduceViewportMode(anchored, { kind: "user-scroll", direction: "up", atEnd: false })
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
