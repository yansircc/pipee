import { Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { BrowserPlatform } from "./browser-platform"

// Shared with the mobile breakpoint in src/styles/app.css.
const MOBILE_QUERY = "(max-width: 760px)"

export const mobileViewportRef = AtomRef.make(false)

export const observeMobileViewport = BrowserPlatform.pipe(
  Effect.flatMap((browser) => browser.watchMediaQuery(MOBILE_QUERY, (matches) => mobileViewportRef.set(matches))),
)
