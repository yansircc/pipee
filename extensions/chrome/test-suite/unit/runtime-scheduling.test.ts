import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";
import {
  localDurabilityRetrySchedule,
  sharedBridgeRetrySchedule,
} from "../../src/browser/runtime-scheduling.js";

const retryTimes = (schedule: Schedule.Schedule<unknown>) =>
  Effect.gen(function* () {
    const times: number[] = [];
    const program = Clock.currentTimeMillis.pipe(
      Effect.tap((now) => Effect.sync(() => times.push(now))),
      Effect.andThen(Effect.fail("offline")),
      Effect.retry({ schedule: schedule.pipe(Schedule.upTo({ times: 2 })) }),
      Random.withSeed("pi-chrome-runtime-schedule"),
    );
    const fiber = yield* Effect.forkChild(program);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.await(fiber);
    return times;
  });

it.effect("keeps the single-writer durability retry deterministic", () =>
  Effect.gen(function* () {
    const times = yield* retryTimes(localDurabilityRetrySchedule);
    expect(times).toEqual([0, 250, 750]);
  }),
);

it.effect("jitters retry pressure shared by Chrome profile workers", () =>
  Effect.gen(function* () {
    const times = yield* retryTimes(sharedBridgeRetrySchedule);
    expect(times).toHaveLength(3);
    const firstDelay = times[1]! - times[0]!;
    const secondDelay = times[2]! - times[1]!;
    expect(firstDelay).toBeGreaterThanOrEqual(200);
    expect(firstDelay).toBeLessThanOrEqual(300);
    expect(secondDelay).toBeGreaterThanOrEqual(400);
    expect(secondDelay).toBeLessThanOrEqual(600);
    expect([firstDelay, secondDelay]).not.toEqual([250, 500]);
  }),
);
