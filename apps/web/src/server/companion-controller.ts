import type { ChromeControlRequestType, LoopControlRequestType, WeixinControlRequestType } from "@/api/contract"
import { Effect } from "effect"

export interface CompanionCommandRunner {
  readonly getCommand: (name: string) =>
    | {
        readonly handler: (args: string, context: unknown) => Promise<void>
      }
    | undefined
  readonly createCommandContext: () => unknown
}

export const makeCompanionController = <E>(
  runner: CompanionCommandRunner,
  unavailable: (name: string) => E,
  commandFailure: (name: string, cause: unknown) => E,
) => {
  const invoke = (name: string, args: string) =>
    Effect.gen(function* () {
      const command = runner.getCommand(name)
      if (command === undefined) return yield* Effect.fail(unavailable(name))
      yield* Effect.tryPromise({
        try: () => command.handler(args, runner.createCommandContext()),
        catch: (cause) => commandFailure(name, cause),
      })
    })

  const chromeArgument = (request: ChromeControlRequestType): string => {
    switch (request.action._tag) {
      case "Authorize":
        return "authorize"
      case "Revoke":
        return "revoke"
      case "WebAttach":
        return `web-attach ${request.action.offer}`
      case "WebAssert":
        return `web-assert ${request.action.pairingId}`
      case "WebDetach":
        return `web-detach ${request.action.pairingId}`
    }
  }

  return {
    invokeSlashCommand: (name: string, args: string) => invoke(name, args),
    controlLoop: (request: LoopControlRequestType) => invoke("loop-control", JSON.stringify(request)),
    controlWeixin: (request: WeixinControlRequestType) => invoke("weixin", request.action._tag.toLowerCase()),
    controlChrome: (request: ChromeControlRequestType) => invoke("chrome", chromeArgument(request)),
  }
}
