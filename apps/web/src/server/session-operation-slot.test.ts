import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { expect } from "vite-plus/test"
import { makeSessionOperationSlot, PiOperationBusyError, type OperationKind } from "./session-operation-slot"

const kinds: ReadonlyArray<OperationKind> = [
  "prompt",
  "bash",
  "compaction",
  "slash-command",
  "loop-control",
  "weixin-control",
  "chrome-control",
]

it.effect("allows exactly one owner across every operation kind", () =>
  Effect.gen(function* () {
    const slot = yield* makeSessionOperationSlot
    const gate = yield* Deferred.make<void>()
    const contenders = yield* Effect.forEach(kinds, (kind, index) =>
      slot.run(kind, `operation-${index}`, Deferred.await(gate)).pipe(Effect.exit, Effect.forkChild),
    )
    yield* Effect.yieldNow

    expect((yield* slot.snapshot)._tag === "Idle").toBe(false)
    yield* Deferred.succeed(gate, undefined)
    const results = yield* Effect.forEach(contenders, Fiber.join)
    const winners = results.filter(Exit.isSuccess)
    const rejected = results.filter(Exit.isFailure)

    expect(winners).toHaveLength(1)
    expect(rejected).toHaveLength(kinds.length - 1)
    expect(rejected.every((result) => Cause.squash(result.cause) instanceof PiOperationBusyError)).toBe(true)
    expect(yield* slot.snapshot).toEqual({ _tag: "Idle" })
  }),
)

it.effect("does not let a stale release clear a successor owner", () =>
  Effect.gen(function* () {
    const slot = yield* makeSessionOperationSlot
    yield* slot.begin("prompt", "first")
    yield* slot.activate("prompt", "first")
    yield* slot.release("prompt", "first")
    yield* slot.begin("bash", "second")
    yield* slot.activate("bash", "second")

    yield* slot.release("prompt", "first")

    expect(yield* slot.snapshot).toEqual({ _tag: "Active", kind: "bash", operationId: "second" })
  }),
)

it.effect("releases the exact owner after failure", () =>
  Effect.gen(function* () {
    const slot = yield* makeSessionOperationSlot
    const failure = yield* slot.run("compaction", "failed", Effect.fail("boom")).pipe(Effect.flip)

    expect(failure).toBe("boom")
    expect(yield* slot.snapshot).toEqual({ _tag: "Idle" })
  }),
)
