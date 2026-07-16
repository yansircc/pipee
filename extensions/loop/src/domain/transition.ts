import { nextCronDue } from "./cron.js";
import {
  occurrencePrompt,
  type CronLoop,
  type IntervalLoop,
  type Loop,
  type Occurrence,
  type Waiting,
} from "./model.js";

export type Gate = "open" | "closed";

export type TransitionResult =
  | { readonly loop: Loop; readonly occurrence?: Occurrence }
  | { readonly loop?: never; readonly occurrence: Occurrence };

const occurrence = (loop: Loop, phase: Waiting, claimedAt: number): Occurrence => ({
  id: `${loop.id}:${phase.cursor}`,
  loopId: loop.id,
  cursor: phase.cursor,
  prompt: occurrencePrompt(loop),
  dueAt: phase.dueAt,
  claimedAt,
  trigger: "scheduled",
});

const advanceCron = (loop: CronLoop, now: number): CronLoop | undefined => {
  if (loop.until !== undefined && now >= loop.until) {
    return undefined;
  }
  const next = nextCronDue(loop.spec, now, loop.id, loop.phase.cursor + 1);
  return next === undefined
    ? undefined
    : {
        ...loop,
        phase: { _tag: "Waiting", dueAt: next, cursor: loop.phase.cursor + 1 },
      };
};

const stableFraction = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
};

const advanceInterval = (loop: IntervalLoop, now: number): IntervalLoop | undefined => {
  if (loop.until !== undefined && now >= loop.until) {
    return undefined;
  }
  const cursor = loop.phase.cursor + 1;
  const jitter = Math.min(
    stableFraction(`${loop.id}:${cursor}`) * loop.spec.jitterFraction * loop.spec.periodMs,
    loop.spec.jitterCapMs,
  );
  return {
    ...loop,
    phase: {
      _tag: "Waiting",
      dueAt: now + loop.spec.periodMs + Math.floor(jitter),
      cursor,
    },
  };
};

export const tick = (loop: Loop, now: number, gate: Gate): TransitionResult => {
  if (
    !loop.enabled ||
    gate === "closed" ||
    loop.phase._tag !== "Waiting" ||
    now < loop.phase.dueAt
  ) {
    return { loop };
  }
  const claimed = occurrence(loop, loop.phase, now);
  switch (loop._tag) {
    case "Once":
      return { occurrence: claimed };
    case "Cron": {
      const advanced = advanceCron(loop, now);
      return advanced ? { loop: advanced, occurrence: claimed } : { occurrence: claimed };
    }
    case "Interval": {
      const advanced = advanceInterval(loop, now);
      return advanced ? { loop: advanced, occurrence: claimed } : { occurrence: claimed };
    }
    case "Manual":
      return {
        loop: {
          ...loop,
          phase: { _tag: "AwaitingArm", cursor: loop.phase.cursor + 1 },
        },
        occurrence: claimed,
      };
  }
};

export const arm = (loop: Loop, at: number): Loop | undefined =>
  loop._tag === "Manual" && loop.phase._tag === "AwaitingArm"
    ? { ...loop, phase: { _tag: "Waiting", dueAt: at, cursor: loop.phase.cursor } }
    : undefined;
