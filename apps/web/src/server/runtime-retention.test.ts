import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vite-plus/test"
import { makeRuntimeRetention } from "./runtime-retention"

const lease = {
  kind: "pi/runtime-lease",
  version: 1,
  owner: "pi-loop",
  reason: "automation-present",
} as const

it.effect("consumes lease projections without exposing them as public status", () =>
  Effect.gen(function* () {
    const retention = yield* makeRuntimeRetention

    expect(retention.update("pi-loop/runtime-lease", lease)).toEqual({ _tag: "RetentionHandled", valid: true })
    expect(yield* retention.hasRetention).toBe(true)
    expect(retention.update("pi-loop/runtime-lease", undefined)).toEqual({ _tag: "RetentionHandled", valid: true })
    expect(yield* retention.hasRetention).toBe(false)
  }),
)

it.effect("fails a retained key closed when its replacement is invalid", () =>
  Effect.gen(function* () {
    const retention = yield* makeRuntimeRetention
    retention.update("pi-loop/runtime-lease", lease)

    expect(retention.update("pi-loop/runtime-lease", { ...lease, version: 2 })).toEqual({
      _tag: "RetentionHandled",
      valid: false,
    })
    expect(yield* retention.hasRetention).toBe(false)
  }),
)

it.effect("fails a malformed lease claim closed before it reaches browser projection", () =>
  Effect.gen(function* () {
    const retention = yield* makeRuntimeRetention

    expect(retention.update("foreign-key", { kind: "pi/runtime-lease", version: 99 })).toEqual({
      _tag: "RetentionHandled",
      valid: false,
    })
    expect(yield* retention.hasRetention).toBe(false)
  }),
)

it.effect("leaves unrelated structured statuses on the public projection path", () =>
  Effect.gen(function* () {
    const retention = yield* makeRuntimeRetention

    expect(retention.update("pi-loop", { kind: "pi-loop/status", version: 1 })).toEqual({
      _tag: "PublicProjection",
    })
    expect(yield* retention.hasRetention).toBe(false)
  }),
)
