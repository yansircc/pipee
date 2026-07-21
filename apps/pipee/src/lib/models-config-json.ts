import { Data, Effect, Schema } from "effect"
import { ModelsConfig } from "@/api/contract"

export class ModelsConfigJsonError extends Data.TaggedError("ModelsConfigJsonError")<{
  readonly operation: "parse" | "decode" | "encode"
  readonly message: string
}> {}

const error = (operation: ModelsConfigJsonError["operation"]) => (cause: unknown) =>
  new ModelsConfigJsonError({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

export const decodeModelsConfig = (value: unknown) =>
  Schema.decodeUnknownEffect(ModelsConfig)(value).pipe(Effect.mapError(error("decode")))

export const parseModelsConfigJson = (source: string) =>
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: error("parse"),
  }).pipe(Effect.flatMap(decodeModelsConfig))

export const formatModelsConfigJson = (value: typeof ModelsConfig.Type) =>
  Schema.encodeUnknownEffect(ModelsConfig)(value).pipe(
    Effect.map((encoded) => `${JSON.stringify(encoded, null, 2)}\n`),
    Effect.mapError(error("encode")),
  )
