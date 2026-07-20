import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect, Ref, Scope } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { LeaseUnavailable, makeLoopRepository } from "../src/application/repository.js";
import { createLoop, DEFAULT_CONFIG } from "../src/domain/model.js";

const withDirectory = <A, E>(
  use: (
    directory: string,
    fs: FileSystem,
    path: Path,
  ) => Effect.Effect<A, E, FileSystem | Path | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-loop-test-" });
      return yield* use(directory, fs, path);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

it.effect("commits durable advance before returning an occurrence", () =>
  withDirectory((directory, fs, path) =>
    Effect.gen(function* () {
      const repository = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      const loop = createLoop({
        _tag: "Once",
        id: "durable-once",
        prompt: "run once",
        retention: "project",
        createdAt: 1,
        dueAt: 10,
      });
      yield* repository.add(loop);
      const occurrences = yield* repository.claimDue(10, "open", "project");
      expect(occurrences.map((item) => item.id)).toEqual(["durable-once:0"]);
      expect(yield* repository.list).toEqual([]);
      const encoded = yield* fs.readFileString(
        path.join(directory, DEFAULT_CONFIG.durableFilePath),
      );
      expect(JSON.parse(encoded)).toEqual({ version: 2, loops: [] });
    }),
  ),
);

it.effect("lets followers mutate session state but rejects durable mutations", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const owner = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      expect(yield* owner.projectAccess).toBe("inactive");
      yield* owner.add(
        createLoop({
          _tag: "Once",
          id: "owned-project-once",
          prompt: "owned project",
          retention: "project",
          createdAt: 1,
          dueAt: 10,
        }),
      );
      const follower = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      expect(yield* owner.projectAccess).toBe("owner");
      expect(yield* follower.projectAccess).toBe("follower");
      yield* follower.add(
        createLoop({
          _tag: "Once",
          id: "session-once",
          prompt: "session",
          retention: "session",
          createdAt: 1,
          dueAt: 10,
        }),
      );
      const exit = yield* Effect.exit(
        follower.add(
          createLoop({
            _tag: "Once",
            id: "project-once",
            prompt: "project",
            retention: "project",
            createdAt: 1,
            dueAt: 10,
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(LeaseUnavailable);
      }
    }),
  ),
);

it.effect("does not lease an empty project and releases ownership with the last project loop", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const first = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      const second = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      expect(yield* first.projectAccess).toBe("inactive");
      expect(yield* second.projectAccess).toBe("inactive");

      const firstLoop = createLoop({
        _tag: "Once",
        id: "first-project-loop",
        prompt: "first project",
        retention: "project",
        createdAt: 1,
        dueAt: 10,
      });
      yield* first.add(firstLoop);
      expect(yield* first.projectAccess).toBe("owner");
      yield* first.remove(firstLoop.id);
      expect(yield* first.projectAccess).toBe("inactive");

      yield* second.add(
        createLoop({
          _tag: "Once",
          id: "second-project-loop",
          prompt: "second project",
          retention: "project",
          createdAt: 2,
          dueAt: 20,
        }),
      );
      expect(yield* second.projectAccess).toBe("owner");
    }),
  ),
);

it.effect("releases empty ownership when the first project mutation fails", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const repository = yield* makeLoopRepository(directory, { ...DEFAULT_CONFIG, maxLoops: 1 });
      yield* repository.add(
        createLoop({
          _tag: "Once",
          id: "session-capacity",
          prompt: "session loop",
          retention: "session",
          createdAt: 1,
          dueAt: 10,
        }),
      );

      const failure = yield* repository
        .add(
          createLoop({
            _tag: "Once",
            id: "project-over-capacity",
            prompt: "project loop",
            retention: "project",
            createdAt: 2,
            dueAt: 20,
          }),
        )
        .pipe(Effect.flip);
      expect(failure._tag).toBe("CapacityExceeded");
      expect(yield* repository.projectAccess).toBe("inactive");

      const successor = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      yield* successor.add(
        createLoop({
          _tag: "Once",
          id: "successor-project-loop",
          prompt: "successor",
          retention: "project",
          createdAt: 3,
          dueAt: 30,
        }),
      );
      expect(yield* successor.projectAccess).toBe("owner");
    }),
  ),
);

it.effect("fails closed on corrupt durable state", () =>
  withDirectory((directory, fs, path) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(directory, DEFAULT_CONFIG.durableFilePath), "not-json");
      const exit = yield* Effect.exit(makeLoopRepository(directory, DEFAULT_CONFIG));
      expect(exit._tag).toBe("Failure");
    }),
  ),
);

it.effect("persists every session-owned mutation through the session adapter", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([]);
      const repository = yield* makeLoopRepository(directory, DEFAULT_CONFIG, {
        initial: [],
        persist: (loops) =>
          Ref.update(snapshots, (values) => [...values, loops]).pipe(Effect.asVoid),
      });
      const loop = createLoop({
        _tag: "Interval",
        id: "session-interval",
        prompt: "inspect",
        retention: "session",
        createdAt: 1,
        firstDueAt: 10,
        spec: { periodMs: 100, jitterFraction: 0, jitterCapMs: 0 },
      });
      yield* repository.add(loop);
      yield* repository.setEnabled(loop.id, false);
      yield* repository.remove(loop.id);
      expect((yield* Ref.get(snapshots)).map((snapshot) => snapshot.length)).toEqual([1, 1, 0]);
    }),
  ),
);
