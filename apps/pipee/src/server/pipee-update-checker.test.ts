import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { makePipeeUpdateChecker, PipeeUpdateCheckError, projectPipeeUpdateStatus } from "./pipee-update-checker"

describe("Pipee update status", () => {
  it("compares strict SemVer without inventing updates", () => {
    expect(projectPipeeUpdateStatus("0.5.0", "0.6.0", 1)._tag).toBe("UpdateAvailable")
    expect(projectPipeeUpdateStatus("0.6.0", "0.6.0", 1)._tag).toBe("Current")
    expect(projectPipeeUpdateStatus("0.6.0", "0.5.0", 1)._tag).toBe("Current")
    expect(projectPipeeUpdateStatus("0.6.0-beta.1", "0.6.0", 1)._tag).toBe("UpdateAvailable")
    expect(projectPipeeUpdateStatus("development", "0.6.0", 1)._tag).toBe("Unavailable")
    expect(projectPipeeUpdateStatus("0.5.0", "latest", 1)._tag).toBe("Unavailable")
  })

  it.effect("serializes and caches registry checks", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const checker = yield* makePipeeUpdateChecker("0.5.0", {
        latestVersion: Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => (count === 1 ? "0.5.0" : "0.6.0")),
        ),
      })

      expect((yield* checker.status)._tag).toBe("Current")
      expect((yield* checker.status)._tag).toBe("Current")
      expect(yield* Ref.get(calls)).toBe(1)

      yield* TestClock.adjust(Duration.millis(6 * 60 * 60 * 1_000 + 1))
      const refreshed = yield* checker.status
      expect(refreshed._tag).toBe("UpdateAvailable")
      expect(yield* Ref.get(calls)).toBe(2)
    }),
  )

  it.effect("caches an unavailable projection briefly without inventing an update", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const checker = yield* makePipeeUpdateChecker("0.5.0", {
        latestVersion: Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(Effect.fail(new PipeeUpdateCheckError({ message: "offline" }))),
        ),
      })

      expect((yield* checker.status)._tag).toBe("Unavailable")
      expect((yield* checker.status)._tag).toBe("Unavailable")
      expect(yield* Ref.get(calls)).toBe(1)
      yield* TestClock.adjust(Duration.millis(15 * 60 * 1_000 + 1))
      expect((yield* checker.status)._tag).toBe("Unavailable")
      expect(yield* Ref.get(calls)).toBe(2)
    }),
  )
})
