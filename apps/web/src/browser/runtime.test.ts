import { it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { expect } from "vite-plus/test"
import { disposeBrowserRuntime, forkEffect } from "./runtime"

it.effect("delivers callbacks once, cancels fibers, and disposes the registry", () =>
  Effect.gen(function* () {
    let successCount = 0
    let failureCount = 0

    const value = yield* Effect.callback<number>((resume) => {
      const cancel = forkEffect(Effect.succeed(42), {
        onSuccess: (result) => {
          successCount += 1
          resume(Effect.succeed(result))
        },
        onFailure: () => {
          failureCount += 1
        },
      })
      return Effect.sync(cancel)
    })
    yield* Effect.yieldNow
    expect(value).toBe(42)
    expect(successCount).toBe(1)
    expect(failureCount).toBe(0)

    const failed = yield* Effect.callback<void>((resume) => {
      const cancel = forkEffect(Effect.fail("boom"), {
        onSuccess: () => {
          successCount += 1
        },
        onFailure: () => {
          failureCount += 1
          resume(Effect.void)
        },
      })
      return Effect.sync(cancel)
    })
    expect(failed).toBeUndefined()
    expect(successCount).toBe(1)
    expect(failureCount).toBe(1)

    let cancelledReleases = 0
    const cancelledStarted = yield* Deferred.make<void>()
    const cancel = forkEffect(
      Effect.scoped(
        Effect.acquireRelease(Deferred.succeed(cancelledStarted, undefined), () =>
          Effect.sync(() => {
            cancelledReleases += 1
          }),
        ).pipe(Effect.andThen(Effect.never)),
      ),
      {
        onSuccess: () => {
          successCount += 1
        },
        onFailure: () => {
          failureCount += 1
        },
      },
    )
    yield* Deferred.await(cancelledStarted)
    cancel()
    cancel()
    yield* Effect.yieldNow
    expect(cancelledReleases).toBe(1)
    expect(successCount).toBe(1)
    expect(failureCount).toBe(1)

    let disposedReleases = 0
    const disposedStarted = yield* Deferred.make<void>()
    forkEffect(
      Effect.scoped(
        Effect.acquireRelease(Deferred.succeed(disposedStarted, undefined), () =>
          Effect.sync(() => {
            disposedReleases += 1
          }),
        ).pipe(Effect.andThen(Effect.never)),
      ),
      {
        onSuccess: () => {
          successCount += 1
        },
      },
    )
    yield* Deferred.await(disposedStarted)
    yield* Effect.sync(disposeBrowserRuntime)
    yield* Effect.yieldNow
    expect(disposedReleases).toBe(1)
    expect(successCount).toBe(1)
  }),
)
