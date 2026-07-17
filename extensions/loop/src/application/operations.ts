import { Clock, Data, Effect } from "effect";
import { nextCronDue, nextCronInstant, parseCron } from "../domain/cron.js";
import { createLoop, type Loop, type LoopConfig, type Retention } from "../domain/model.js";
import type { LoopRepository } from "./repository.js";

export class InvalidSchedule extends Data.TaggedError("InvalidSchedule")<{
  readonly input: string;
}> {}

export class DelayOutOfRange extends Data.TaggedError("DelayOutOfRange")<{
  readonly delaySeconds: number;
}> {}

export type LoopScheduleInput =
  | { readonly kind: "interval"; readonly periodSeconds: number; readonly runImmediately: boolean }
  | { readonly kind: "cron"; readonly expression: string }
  | { readonly kind: "once"; readonly delaySeconds: number }
  | { readonly kind: "dynamic" };

export type CreateLoopInput = {
  readonly prompt: string;
  readonly retention: Retention;
  readonly schedule: LoopScheduleInput;
  readonly label?: string;
};

export type UpdateLoopInput = {
  readonly id: string;
  readonly prompt?: string;
  readonly label?: string | null;
  readonly schedule?: LoopScheduleInput;
};

const loopId = (): string => globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const cronSpec = (expression: string, config: LoopConfig) => ({
  expression,
  timeZone: config.timeZone,
  missed: "coalesce" as const,
  jitterFraction: config.recurringJitterFraction,
  jitterCapMs: config.recurringJitterCapMs,
});

const withLabel = (loop: Loop, label: string | undefined): Loop => {
  const { label: _previous, ...unlabeled } = loop;
  return (label === undefined ? unlabeled : { ...unlabeled, label }) as Loop;
};

const buildLoop = (
  config: LoopConfig,
  input: CreateLoopInput & { readonly id: string; readonly createdAt: number },
): Effect.Effect<Loop, InvalidSchedule | DelayOutOfRange> => {
  const common = {
    id: input.id,
    prompt: input.prompt,
    retention: input.retention,
    createdAt: input.createdAt,
    ...(input.label === undefined ? {} : { label: input.label }),
  };
  switch (input.schedule.kind) {
    case "interval": {
      const periodMs = input.schedule.periodSeconds * 1_000;
      if (!Number.isSafeInteger(periodMs) || periodMs < 1_000) {
        return Effect.fail(new InvalidSchedule({ input: String(input.schedule.periodSeconds) }));
      }
      return Effect.succeed(
        createLoop({
          _tag: "Interval",
          ...common,
          firstDueAt: input.schedule.runImmediately ? input.createdAt : input.createdAt + periodMs,
          spec: {
            periodMs,
            jitterFraction: config.recurringJitterFraction,
            jitterCapMs: config.recurringJitterCapMs,
          },
          ...(config.recurringMaxAgeMs === 0
            ? {}
            : { until: input.createdAt + config.recurringMaxAgeMs }),
        }),
      );
    }
    case "cron": {
      if (!parseCron(input.schedule.expression)) {
        return Effect.fail(new InvalidSchedule({ input: input.schedule.expression }));
      }
      const spec = cronSpec(input.schedule.expression, config);
      const base = nextCronInstant(spec, input.createdAt);
      if (base === undefined) {
        return Effect.fail(new InvalidSchedule({ input: input.schedule.expression }));
      }
      return Effect.succeed(
        createLoop({
          _tag: "Cron",
          ...common,
          firstDueAt: nextCronDue(spec, input.createdAt, input.id, 0) ?? base,
          spec,
          ...(config.recurringMaxAgeMs === 0
            ? {}
            : { until: input.createdAt + config.recurringMaxAgeMs }),
        }),
      );
    }
    case "once": {
      if (!Number.isSafeInteger(input.schedule.delaySeconds) || input.schedule.delaySeconds < 1) {
        return Effect.fail(new DelayOutOfRange({ delaySeconds: input.schedule.delaySeconds }));
      }
      return Effect.succeed(
        createLoop({
          _tag: "Once",
          ...common,
          dueAt: input.createdAt + input.schedule.delaySeconds * 1_000,
        }),
      );
    }
    case "dynamic":
      return input.retention === "project"
        ? Effect.fail(new InvalidSchedule({ input: "dynamic project loop" }))
        : Effect.succeed(
            createLoop({
              _tag: "Manual",
              ...common,
              retention: "session",
              firstDueAt: input.createdAt,
            }),
          );
  }
};

export const makeLoopOperations = (repository: LoopRepository, config: LoopConfig) => {
  const create = (input: CreateLoopInput) =>
    Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis;
      const loop = yield* buildLoop(config, { ...input, id: loopId(), createdAt });
      yield* repository.add(loop);
      return loop;
    });

  const update = (input: UpdateLoopInput) =>
    Effect.gen(function* () {
      if (input.prompt === undefined && input.label === undefined && input.schedule === undefined) {
        return yield* new InvalidSchedule({ input: "empty loop update" });
      }
      const current = yield* repository.get(input.id);
      const prompt = input.prompt ?? current.prompt;
      const label = input.label === undefined ? current.label : (input.label ?? undefined);
      if (input.schedule === undefined) {
        return yield* repository.replace(input.id, withLabel({ ...current, prompt }, label));
      }
      const now = yield* Clock.currentTimeMillis;
      const replacement = yield* buildLoop(config, {
        id: current.id,
        prompt,
        retention: current.retention,
        createdAt: now,
        schedule: input.schedule,
        ...(label === undefined ? {} : { label }),
      });
      return yield* repository.replace(
        input.id,
        withLabel(
          {
            ...replacement,
            createdAt: current.createdAt,
            enabled: current.enabled,
            manualCursor: current.manualCursor,
          } as Loop,
          label,
        ),
      );
    });

  const scheduleWakeup = (id: string, delaySeconds: number) =>
    Effect.gen(function* () {
      if (!Number.isFinite(delaySeconds) || delaySeconds < 60 || delaySeconds > 3_600) {
        return yield* new DelayOutOfRange({ delaySeconds });
      }
      const now = yield* Clock.currentTimeMillis;
      return yield* repository.arm(id, now + Math.floor(delaySeconds * 1_000));
    });

  const removeAll = Effect.gen(function* () {
    const session = yield* repository.removeAll("session");
    const project = yield* repository.removeAll("project");
    return [...session, ...project];
  });

  return {
    create,
    update,
    scheduleWakeup,
    setEnabled: repository.setEnabled,
    list: repository.list,
    remove: repository.remove,
    removeAll,
  } as const;
};

export type LoopOperations = ReturnType<typeof makeLoopOperations>;
