import { Schema } from "effect"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const LoopScheduleProjection = Schema.Union([
  Schema.TaggedStruct("Interval", { periodMs: PositiveInt }),
  Schema.TaggedStruct("Dynamic", {}),
  Schema.TaggedStruct("Cron", { expression: Schema.NonEmptyString, timeZone: Schema.NonEmptyString }),
  Schema.TaggedStruct("Once", {}),
])

export const LoopPhaseProjection = Schema.Union([
  Schema.TaggedStruct("Scheduled", { dueAt: NonNegativeInt }),
  Schema.TaggedStruct("AwaitingAgent", {}),
  Schema.TaggedStruct("Paused", { dueAt: Schema.optionalKey(NonNegativeInt) }),
])

export const LoopProjection = Schema.Struct({
  id: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  label: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: NonNegativeInt,
  enabled: Schema.Boolean,
  retention: Schema.Literals(["session", "project"]),
  schedule: LoopScheduleProjection,
  phase: LoopPhaseProjection,
})
export type LoopProjection = typeof LoopProjection.Type

export const LoopStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-loop/status"),
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  observedAt: NonNegativeInt,
  loops: Schema.Array(LoopProjection),
})
export type LoopStatusProjection = typeof LoopStatusProjection.Type
