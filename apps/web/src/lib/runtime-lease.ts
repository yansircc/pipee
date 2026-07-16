import { Schema } from "effect"
import type { ExtensionStatusContribution } from "@/api/contract"

const RuntimeLeaseProjection = Schema.Struct({
  kind: Schema.Literal("pi/runtime-lease"),
  version: Schema.Literal(1),
  owner: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
})

const decodeLease = Schema.decodeUnknownOption(RuntimeLeaseProjection)

export const hasRuntimeLease = (statuses: ReadonlyArray<ExtensionStatusContribution>): boolean =>
  statuses.some((item) => item._tag === "Structured" && decodeLease(item.value)._tag === "Some")
