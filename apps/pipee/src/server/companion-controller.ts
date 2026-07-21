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

  return {
    invokeSlashCommand: (name: string, args: string) => invoke(name, args),
  }
}
