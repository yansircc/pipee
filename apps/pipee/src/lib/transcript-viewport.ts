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
  readonly rowPosition: number
  readonly headerSize: number
  readonly scrollOffset: number
  readonly userScrollGeneration: number
}

export const isViewportNavigationGesture = (
  kind: "wheel" | "touchmove" | "pointerdown",
  targetsScrollSurface: boolean,
): boolean => kind !== "pointerdown" || targetsScrollSurface

export function restoreScrollOffset(
  anchor: LogicalViewportAnchor,
  next: { readonly rowPosition: number; readonly headerSize: number },
): number {
  return anchor.scrollOffset + next.rowPosition - anchor.rowPosition + next.headerSize - anchor.headerSize
}

export function reduceViewportMode(mode: ViewportMode, event: ViewportEvent): ViewportMode {
  if (event.kind === "session-reset" || event.kind === "scroll-to-latest") return initialViewportMode
  if (event.kind === "jump-to-turn") return { kind: "free-scrolling" }
  if (event.kind === "new-turn") return mode
  if (event.direction === "up") return { kind: "free-scrolling" }
  return event.atEnd ? initialViewportMode : mode
}
