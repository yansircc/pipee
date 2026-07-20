import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { expect } from "vite-plus/test";
import { RuntimeLoopOwner } from "../../src/browser/runtime-loop-owner.js";

it.effect(
  "restarts one runtime loop by interrupting the old loop before launching the new loop",
  () =>
    Effect.gen(function* () {
      let active = 0;
      let maximumActive = 0;
      let starts = 0;
      let stops = 0;
      const runtime = Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          starts += 1;
        }),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            active -= 1;
            stops += 1;
          }),
      );
      const effectRuntime = ManagedRuntime.make(Layer.empty);
      const owner = RuntimeLoopOwner.makeUnsafe(runtime, effectRuntime.runFork);

      yield* owner.start;
      yield* owner.start;
      expect({ active, starts, stops }).toEqual({ active: 1, starts: 1, stops: 0 });

      yield* owner.restart;
      expect({ active, starts, stops }).toEqual({ active: 1, starts: 2, stops: 1 });
      expect(maximumActive).toBe(1);

      yield* Effect.all([owner.restart, owner.restart], {
        concurrency: "unbounded",
        discard: true,
      });
      expect({ active, starts, stops }).toEqual({ active: 1, starts: 4, stops: 3 });
      expect(maximumActive).toBe(1);

      yield* owner.stop;
      expect({ active, starts, stops }).toEqual({ active: 0, starts: 4, stops: 4 });
    }),
);
