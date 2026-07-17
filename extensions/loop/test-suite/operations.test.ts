import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { makeLoopOperations, InvalidSchedule } from "../src/application/operations.js";
import { makeLoopRepository } from "../src/application/repository.js";
import { DEFAULT_CONFIG } from "../src/domain/model.js";

it.effect("derives every public schedule variant from one create algebra", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-loop-operations-" });
      const repository = yield* makeLoopRepository(cwd, DEFAULT_CONFIG, {
        initial: [],
        persist: () => Effect.void,
      });
      const operations = makeLoopOperations(repository, DEFAULT_CONFIG);
      const interval = yield* operations.create({
        prompt: "interval",
        retention: "session",
        schedule: { kind: "interval", periodSeconds: 30, runImmediately: false },
      });
      const cron = yield* operations.create({
        prompt: "cron",
        retention: "session",
        schedule: { kind: "cron", expression: "*/5 * * * *" },
      });
      const once = yield* operations.create({
        prompt: "once",
        retention: "session",
        schedule: { kind: "once", delaySeconds: 20 },
      });
      const dynamic = yield* operations.create({
        prompt: "dynamic",
        retention: "session",
        schedule: { kind: "dynamic" },
      });

      expect([interval._tag, cron._tag, once._tag, dynamic._tag]).toEqual([
        "Interval",
        "Cron",
        "Once",
        "Manual",
      ]);
      expect(interval._tag === "Interval" && interval.spec.periodMs).toBe(30_000);
      expect(
        once._tag === "Once" && once.phase._tag === "Waiting" && once.phase.dueAt > once.createdAt,
      ).toBe(true);

      const updated = yield* operations.update({
        id: interval.id,
        prompt: "updated",
        schedule: { kind: "once", delaySeconds: 10 },
      });
      expect(updated).toMatchObject({ id: interval.id, prompt: "updated", _tag: "Once" });

      const rejected = yield* Effect.exit(
        operations.create({
          prompt: "invalid",
          retention: "project",
          schedule: { kind: "dynamic" },
        }),
      );
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") {
        expect(Cause.squash(rejected.cause)).toBeInstanceOf(InvalidSchedule);
      }
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);
