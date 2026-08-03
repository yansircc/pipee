export type ViewportMode = { readonly kind: "following-end" } | { readonly kind: "free-scrolling" }

export type ViewportEvent =
  | { readonly kind: "session-reset" }
  | { readonly kind: "new-turn"; readonly turnId: string; readonly viewportOffset: number }
  | { readonly kind: "user-scroll"; readonly direction: "up" | "down"; readonly atEnd: boolean }
  | { readonly kind: "scroll-to-latest" }
  | { readonly kind: "jump-to-turn" }

export const initialViewportMode: ViewportMode = { kind: "following-end" }

export interface LogicalViewportAnchor {
  readonly rowId: string
  readonly dataLength: number
  /**
   * This is the visual fact that must survive a prepend. Virtual-list item
   * positions are estimates while rows and the header are being measured, so
   * they are not an anchor source of truth.
   */
  readonly viewportTop: number
  readonly userScrollGeneration: number
}

export const isViewportNavigationGesture = (
  kind: "wheel" | "touchmove" | "pointerdown",
  targetsScrollSurface: boolean,
): boolean => kind !== "pointerdown" || targetsScrollSurface

export function restoreScrollOffset(
  anchor: LogicalViewportAnchor,
  next: { readonly scrollOffset: number; readonly viewportTop: number },
): number {
  return next.scrollOffset + next.viewportTop - anchor.viewportTop
}

export function reduceViewportMode(mode: ViewportMode, event: ViewportEvent): ViewportMode {
  if (event.kind === "session-reset" || event.kind === "scroll-to-latest") return initialViewportMode
  if (event.kind === "jump-to-turn") return { kind: "free-scrolling" }
  if (event.kind === "new-turn") return mode
  if (event.direction === "up") return { kind: "free-scrolling" }
  return event.atEnd ? initialViewportMode : mode
}
