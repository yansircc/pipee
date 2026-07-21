import { Cause, Effect, Layer } from "effect"
import { BrowserRuntime } from "@effect/platform-browser"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { BrowserPlatform, BrowserPlatformLive } from "./browser-platform"
import { PiWebHttpClient, PiWebHttpClientLive } from "./http-api-client"
import { BrowserPreferences, BrowserPreferencesLive } from "./preferences"

export interface RuntimeCallbacks<A> {
  readonly onSuccess: (value: A) => void
  readonly onFailure?: (error: unknown) => void
}

export type BrowserServices = BrowserPlatform | BrowserPreferences | PiWebHttpClient
export type Cancel = () => void

const BrowserLive = Layer.mergeAll(BrowserPlatformLive, BrowserPreferencesLive, PiWebHttpClientLive)

const registry = AtomRegistry.make()
const runtime = Atom.runtime(BrowserLive)

export const disposeBrowserRuntime = () => registry.dispose()

export const forkEffect = <A, E, R extends BrowserServices>(
  effect: Effect.Effect<A, E, R>,
  callbacks: RuntimeCallbacks<A>,
): Cancel => {
  let active = true
  let unmount: () => void = () => undefined
  const dispose = () => {
    if (!active) return
    active = false
    unmount()
  }
  const action = runtime.fn<void>()(() =>
    effect.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(() => callbacks.onFailure?.(Cause.squash(cause))),
        onSuccess: (value) => Effect.sync(() => callbacks.onSuccess(value)),
      }),
      Effect.ensuring(Effect.sync(dispose)),
    ),
  )
  unmount = registry.mount(action)
  registry.set(action, undefined)
  return () => {
    if (!active) return
    registry.set(action, Atom.Interrupt)
    dispose()
  }
}

if (typeof globalThis.addEventListener === "function") {
  BrowserRuntime.runMain(
    Effect.scoped(
      Effect.acquireRelease(Effect.void, () => Effect.sync(disposeBrowserRuntime)).pipe(Effect.andThen(Effect.never)),
    ),
  )
}

if (import.meta.hot) import.meta.hot.dispose(disposeBrowserRuntime)
