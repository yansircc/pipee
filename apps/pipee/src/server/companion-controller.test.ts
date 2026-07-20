import { expect, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { makeCompanionController } from "./companion-controller"

class TestCompanionError extends Data.TaggedError("TestCompanionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

it.effect("invokes an explicitly named Pi slash command", () =>
  Effect.gen(function* () {
    const calls: Array<readonly [string, string]> = []
    let activeName = ""
    const controller = makeCompanionController(
      {
        getCommand: (name) => {
          activeName = name
          return {
            handler: async (args) => {
              calls.push([activeName, args])
            },
          }
        },
        createCommandContext: () => ({}),
      },
      (name) => new TestCompanionError({ message: `missing:${name}` }),
      (name, cause) => new TestCompanionError({ message: `failed:${name}`, cause }),
    )

    yield* controller.invokeSlashCommand("inspect", "current")

    expect(calls).toEqual([["inspect", "current"]])
  }),
)

it.effect("fails closed when the fixed companion command is absent", () =>
  Effect.gen(function* () {
    const controller = makeCompanionController(
      { getCommand: () => undefined, createCommandContext: () => ({}) },
      (name) => new TestCompanionError({ message: `missing:${name}` }),
      (name, cause) => new TestCompanionError({ message: `failed:${name}`, cause }),
    )

    const error = yield* Effect.flip(controller.invokeSlashCommand("missing", ""))
    expect(error.message).toBe("missing:missing")
  }),
)
