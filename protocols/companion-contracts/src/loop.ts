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

export const LoopControlRequest = Schema.Struct({
  kind: Schema.Literal("pi-loop/control"),
  version: Schema.Literal(1),
  action: Schema.Union([
    Schema.TaggedStruct("CreateInterval", { periodMs: PositiveInt, prompt: Schema.NonEmptyString }),
    Schema.TaggedStruct("UpdateInterval", {
      id: Schema.NonEmptyString,
      periodMs: PositiveInt,
      prompt: Schema.NonEmptyString,
    }),
    Schema.TaggedStruct("SetEnabled", { id: Schema.NonEmptyString, enabled: Schema.Boolean }),
    Schema.TaggedStruct("Delete", { id: Schema.NonEmptyString }),
    Schema.TaggedStruct("RunNow", { id: Schema.NonEmptyString }),
  ]),
})
export type LoopControlRequest = typeof LoopControlRequest.Type
