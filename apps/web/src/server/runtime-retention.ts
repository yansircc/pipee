import { RuntimeLeaseProjection } from "@pi-suite/companion-contracts/runtime"
import { Effect, Option, Ref, Schema } from "effect"

export type RuntimeRetentionUpdate =
  | { readonly _tag: "PublicProjection" }
  | { readonly _tag: "RetentionHandled"; readonly valid: boolean }

export interface RuntimeRetention {
  readonly hasRetention: Effect.Effect<boolean>
  readonly update: (key: string, value: unknown) => RuntimeRetentionUpdate
}

const decodeLease = Schema.decodeUnknownOption(RuntimeLeaseProjection)
const decodeLeaseClaim = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.Literal("pi/runtime-lease") }))

export const makeRuntimeRetention = Effect.gen(function* () {
  const keys = yield* Ref.make<ReadonlySet<string>>(new Set())

  const update = (key: string, value: unknown): RuntimeRetentionUpdate => {
    const current = Ref.getUnsafe(keys)
    const previous = current.has(key)
    const lease = value === undefined ? undefined : Option.getOrUndefined(decodeLease(value))
    const claimsRetention = value !== undefined && Option.isSome(decodeLeaseClaim(value))
    if (!previous && lease === undefined && !claimsRetention) return { _tag: "PublicProjection" }

    const next = new Set(current)
    next.delete(key)
    if (lease !== undefined) next.add(key)
    keys.ref.current = next
    return { _tag: "RetentionHandled", valid: value === undefined || lease !== undefined }
  }

  return {
    hasRetention: Ref.get(keys).pipe(Effect.map((current) => current.size > 0)),
    update,
  } satisfies RuntimeRetention
})
