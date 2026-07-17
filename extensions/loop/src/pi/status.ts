import {
  LoopPhaseProjection,
  LoopProjection,
  LoopScheduleProjection,
  LoopStatusProjection,
  type LoopProjection as LoopProjectionType,
} from "@pi-suite/companion-contracts/loop";
import type { Loop } from "../domain/model.js";

export { LoopPhaseProjection, LoopProjection, LoopScheduleProjection, LoopStatusProjection };

const schedule = (loop: Loop): LoopProjectionType["schedule"] => {
  switch (loop._tag) {
    case "Interval":
      return { _tag: "Interval", periodMs: loop.spec.periodMs };
    case "Manual":
      return { _tag: "Dynamic" };
    case "Cron":
      return { _tag: "Cron", expression: loop.spec.expression, timeZone: loop.spec.timeZone };
    case "Once":
      return { _tag: "Once" };
  }
};

const phase = (loop: Loop): LoopProjectionType["phase"] => {
  if (!loop.enabled) {
    return {
      _tag: "Paused",
      ...(loop.phase._tag === "Waiting" ? { dueAt: loop.phase.dueAt } : {}),
    };
  }
  return loop.phase._tag === "Waiting"
    ? { _tag: "Scheduled", dueAt: loop.phase.dueAt }
    : { _tag: "AwaitingAgent" };
};

export const projectLoop = (loop: Loop): LoopProjectionType => ({
  id: loop.id,
  prompt: loop.prompt,
  ...(loop.label === undefined ? {} : { label: loop.label }),
  createdAt: loop.createdAt,
  enabled: loop.enabled,
  retention: loop.retention,
  schedule: schedule(loop),
  phase: phase(loop),
});

export const projectLoops = (loops: ReadonlyArray<Loop>): ReadonlyArray<LoopProjectionType> =>
  [...loops]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(projectLoop);
