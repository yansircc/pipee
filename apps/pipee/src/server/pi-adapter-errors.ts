import { Data, Effect, Schema } from "effect"

export class PiAdapterError extends Data.TaggedError("PiAdapterError")<{
  readonly operation: string
  readonly message: string
}> {}

export class PiPromptIdempotencyError extends Data.TaggedError("PiPromptIdempotencyError")<{
  readonly requestId: string
  readonly reason: "PayloadMismatch" | "InDoubt"
  readonly message: string
}> {}

export const adapterError = (operation: string) => (cause: unknown) =>
  new PiAdapterError({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

export const decode = <S extends Schema.Top>(schema: S, operation: string, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new PiAdapterError({ operation, message: String(cause) })),
  )

export const decodeOnExecution = <S extends Schema.Top>(schema: S, operation: string, read: () => unknown) =>
  Effect.suspend(() => decode(schema, operation, read()))
