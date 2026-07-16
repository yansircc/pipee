import { Schema } from "effect"
import type { ExtensionStatusItem } from "@/api/contract"

const RuntimeLeaseProjection = Schema.Struct({
  kind: Schema.Literal("pi/runtime-lease"),
  version: Schema.Literal(1),
  owner: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
})

const decodeLease = Schema.decodeUnknownOption(RuntimeLeaseProjection)

export const hasRuntimeLease = (statuses: ReadonlyArray<ExtensionStatusItem>): boolean =>
  statuses.some((item) => decodeLease(item.status)._tag === "Some")
