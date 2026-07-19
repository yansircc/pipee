import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";
import { Schema } from "effect";
import type { Loop } from "../domain/model.js";
import { projectLoops } from "./status.js";

const Schedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    periodSeconds: Schema.Finite,
    runImmediately: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), expression: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("once"), delaySeconds: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("dynamic") }),
]);

export const LoopWebAction = Schema.Union([
  Schema.TaggedStruct("RunNow", { id: Schema.String }),
  Schema.TaggedStruct("SetEnabled", { id: Schema.String, enabled: Schema.Boolean }),
  Schema.TaggedStruct("Delete", { id: Schema.String }),
  Schema.TaggedStruct("Update", {
    id: Schema.String,
    label: Schema.NullOr(Schema.String),
    prompt: Schema.String,
    schedule: Schedule,
  }),
]);
export type LoopWebAction = typeof LoopWebAction.Type;

export const projectLoopWebView = (
  loops: ReadonlyArray<Loop>,
  sessionId: string,
  observedAt: number,
): JsonValue => ({
  kind: "pi-loop/web-surface",
  version: 1,
  sessionId,
  observedAt,
  loops: projectLoops(loops),
});
