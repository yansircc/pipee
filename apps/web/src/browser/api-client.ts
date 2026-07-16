import { Effect, Stream } from "effect"
import { apiUrls, withApi } from "./http-api-client"
import { forkEffect, type BrowserServices, type Cancel, type RuntimeCallbacks } from "./runtime"

export { apiUrls, withApi }
export type { Cancel }

export type ApiCallbacks<A> = RuntimeCallbacks<A>

export const runApi = <A, E, R extends BrowserServices>(
  effect: Effect.Effect<A, E, R>,
  callbacks: ApiCallbacks<A>,
): Cancel => forkEffect(effect, callbacks)

export const runBrowser = runApi

export const runApiStream = <A, E, E2, R extends BrowserServices>(
  streamEffect: Effect.Effect<Stream.Stream<A, E>, E2, R>,
  callbacks: {
    readonly onValue: (value: A) => void
    readonly onFailure?: (error: unknown) => void
    readonly onEnd?: () => void
  },
): Cancel =>
  forkEffect(
    streamEffect.pipe(
      Effect.flatMap((stream) =>
        stream.pipe(Stream.runForEach((value) => Effect.sync(() => callbacks.onValue(value)))),
      ),
    ),
    {
      onSuccess: () => callbacks.onEnd?.(),
      onFailure: callbacks.onFailure,
    },
  )
