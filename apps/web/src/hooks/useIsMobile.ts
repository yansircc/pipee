import { useSyncExternalStore } from "react"
import { mobileViewportRef } from "@/browser/viewport"

const subscribe = (listener: () => void) => mobileViewportRef.subscribe(listener)
const getSnapshot = () => mobileViewportRef.value
const getServerSnapshot = () => false

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
