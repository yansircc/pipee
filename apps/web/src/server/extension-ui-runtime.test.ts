import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { expect } from "vite-plus/test"
import type { SessionScopedEvent } from "@/api/contract"
import { makeExtensionUiRuntime, PiExtensionUiClosedError } from "./extension-ui-runtime"

it.effect("closes admission atomically with an interaction entering the runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const idRequested = yield* Deferred.make<void>()
      const releaseId = yield* Deferred.make<void>()
      const events: Array<SessionScopedEvent> = []
      const runtime = yield* makeExtensionUiRuntime(
        {
          randomUUIDv4: Deferred.succeed(idRequested, undefined).pipe(
            Effect.andThen(Deferred.await(releaseId)),
            Effect.as("00000000-0000-4000-8000-000000000001"),
          ),
        },
        (event) => events.push(event),
        {},
        () => new Error("unavailable"),
      )

      const interaction = runtime.uiContext.input("Name")
      yield* Deferred.await(idRequested)
      const closing = yield* runtime.dispose.pipe(Effect.forkChild)
      yield* Deferred.succeed(releaseId, undefined)

      expect(yield* Effect.promise(() => interaction)).toBeUndefined()
      yield* Fiber.join(closing)
      expect(runtime.projection().pendingInteraction).toBeNull()
      expect(events.some((event) => event._tag === "ExtensionUiChanged")).toBe(true)

      const rejected = yield* Effect.promise(() =>
        runtime.uiContext.input("Too late").then(
          () => undefined,
          (error: unknown) => error,
        ),
      )
      expect(rejected).toBeInstanceOf(PiExtensionUiClosedError)
    }),
  ),
)

it.effect("interrupts callback fibers instead of waiting forever during close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const callbackStarted = yield* Deferred.make<void>()
      const runtime = yield* makeExtensionUiRuntime(
        {
          randomUUIDv4: Deferred.succeed(callbackStarted, undefined).pipe(Effect.andThen(Effect.never)),
        },
        () => undefined,
        {},
        () => new Error("unavailable"),
      )

      runtime.uiContext.notify("will never receive an id")
      yield* Deferred.await(callbackStarted)
      yield* runtime.dispose
    }),
  ),
)
