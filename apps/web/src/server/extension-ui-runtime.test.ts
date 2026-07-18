import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { expect } from "vite-plus/test"
import type { SessionScopedEvent } from "@/api/contract"
import {
  MEDIA_VIEW_CAPABILITY,
  RUNTIME_RETENTION_CAPABILITY,
  STRUCTURED_VIEW_CAPABILITY,
  type MediaViewPort,
  type RuntimeRetentionPort,
  type StructuredViewPort,
} from "@pi-suite/companion-contracts/host-capabilities"
import { capabilitySlotKey } from "@pi-suite/host-runtime/extension-capabilities"
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

it.effect("keeps structured views and retention on independent owner-bound ports", () =>
  Effect.gen(function* () {
    const runtime = yield* makeExtensionUiRuntime(
      { randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000001") },
      () => undefined,
      {},
      () => new Error("unavailable"),
    )
    const structured = runtime.uiContext.getPiSuiteCapability<StructuredViewPort>("alpha", STRUCTURED_VIEW_CAPABILITY)!
    const retention = runtime.uiContext.getPiSuiteCapability<RuntimeRetentionPort>(
      "alpha",
      RUNTIME_RETENTION_CAPABILITY,
    )!
    const media = runtime.uiContext.getPiSuiteCapability<MediaViewPort>("alpha", MEDIA_VIEW_CAPABILITY)!

    structured.replace("status", { kind: "alpha/status", version: 1, ready: true })
    expect(runtime.projection().statuses[0]).toMatchObject({
      key: capabilitySlotKey("alpha", "status"),
      kind: "alpha/status",
      version: 1,
    })
    expect(yield* runtime.hasRetention).toBe(false)

    media.replace("preview", {
      dataUrl: "data:image/png;base64,AA==",
      alt: "preview",
      width: 1,
      height: 1,
    })
    expect(runtime.projection().widgets[0]?.key).toBe(capabilitySlotKey("alpha", "preview"))

    const handle = retention.acquire("runtime", { reason: "running" })
    expect(yield* runtime.hasRetention).toBe(true)
    expect(runtime.projection().statuses).toHaveLength(1)
    media.replace("preview", undefined)
    expect(runtime.projection().widgets).toHaveLength(0)
    expect(yield* runtime.hasRetention).toBe(true)
    handle.release()
    expect(yield* runtime.hasRetention).toBe(false)
    expect(runtime.projection().statuses).toHaveLength(1)
    yield* runtime.dispose
  }),
)
