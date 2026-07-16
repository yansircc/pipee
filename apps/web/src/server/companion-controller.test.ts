import { expect, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { makeCompanionController } from "./companion-controller"

class TestCompanionError extends Data.TaggedError("TestCompanionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

it.effect("projects typed companion controls onto fixed private Pi commands", () =>
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

    yield* controller.controlWeixin({ action: { _tag: "Login" } })
    yield* controller.controlChrome({ action: { _tag: "WebAssert", pairingId: "pair-1" } })
    yield* controller.controlLoop({
      kind: "pi-loop/control",
      version: 1,
      action: { _tag: "RunNow", id: "loop-1" },
    })

    expect(calls).toEqual([
      ["weixin", "login"],
      ["chrome", "web-assert pair-1"],
      ["loop-control", '{"kind":"pi-loop/control","version":1,"action":{"_tag":"RunNow","id":"loop-1"}}'],
    ])
  }),
)

it.effect("fails closed when the fixed companion command is absent", () =>
  Effect.gen(function* () {
    const controller = makeCompanionController(
      { getCommand: () => undefined, createCommandContext: () => ({}) },
      (name) => new TestCompanionError({ message: `missing:${name}` }),
      (name, cause) => new TestCompanionError({ message: `failed:${name}`, cause }),
    )

    const error = yield* Effect.flip(controller.controlWeixin({ action: { _tag: "Status" } }))
    expect(error.message).toBe("missing:weixin")
  }),
)
