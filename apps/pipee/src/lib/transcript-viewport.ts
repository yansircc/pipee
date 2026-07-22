export type ViewportMode =
  | { readonly kind: "following-end" }
  | { readonly kind: "anchoring-turn"; readonly turnId: string; readonly viewportOffset: number }
  | { readonly kind: "free-scrolling" }

export type ViewportEvent =
  | { readonly kind: "session-reset" }
  | { readonly kind: "new-turn"; readonly turnId: string; readonly viewportOffset: number }
  | { readonly kind: "user-scroll"; readonly direction: "up" | "down"; readonly atEnd: boolean }
  | { readonly kind: "scroll-to-latest" }
  | { readonly kind: "jump-to-turn" }

export const initialViewportMode: ViewportMode = { kind: "following-end" }

export function reduceViewportMode(mode: ViewportMode, event: ViewportEvent): ViewportMode {
  if (event.kind === "session-reset" || event.kind === "scroll-to-latest") return initialViewportMode
  if (event.kind === "jump-to-turn") return { kind: "free-scrolling" }
  if (event.kind === "new-turn") {
    return mode.kind === "following-end"
      ? { kind: "anchoring-turn", turnId: event.turnId, viewportOffset: event.viewportOffset }
      : mode
  }
  if (event.direction === "up") return { kind: "free-scrolling" }
  return event.atEnd ? initialViewportMode : mode
}
