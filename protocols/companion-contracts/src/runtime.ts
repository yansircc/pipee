import { Schema } from "effect"

export const RuntimeLeaseProjection = Schema.Struct({
  kind: Schema.Literal("pi/runtime-lease"),
  version: Schema.Literal(1),
  owner: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
})
export type RuntimeLeaseProjection = typeof RuntimeLeaseProjection.Type
