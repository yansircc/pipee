import { acquireCrossProcessLease } from "@pipee/host-runtime/cross-process-lease";
import { Data, Effect, Exit, Ref, Schema, Scope, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { arm as armTransition, tick, type Gate } from "../domain/transition.js";
import {
  DurableFile,
  occurrencePrompt,
  type Loop,
  type LoopConfig,
  type LoopId,
  type Occurrence,
} from "../domain/model.js";

export class RepositoryFailure extends Data.TaggedError("RepositoryFailure")<{
  readonly operation: "load" | "persist" | "lease";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LeaseUnavailable extends Data.TaggedError("LeaseUnavailable")<{
  readonly message: string;
}> {}

export class CapacityExceeded extends Data.TaggedError("CapacityExceeded")<{
  readonly maximum: number;
}> {}

export class LoopNotFound extends Data.TaggedError("LoopNotFound")<{
  readonly id: string;
}> {}

export class LoopStateConflict extends Data.TaggedError("LoopStateConflict")<{
  readonly id: string;
  readonly expected: string;
}> {}

export type MutationError =
  | RepositoryFailure
  | LeaseUnavailable
  | CapacityExceeded
  | LoopNotFound
  | LoopStateConflict;

export type LoopRepository = {
  readonly projectAccess: Effect.Effect<"inactive" | "owner" | "follower">;
  readonly add: (loop: Loop) => Effect.Effect<void, MutationError>;
  readonly list: Effect.Effect<ReadonlyArray<Loop>>;
  readonly get: (id: LoopId) => Effect.Effect<Loop, LoopNotFound>;
  readonly remove: (id: LoopId) => Effect.Effect<Loop, MutationError>;
  readonly removeAll: (
    retention: Loop["retention"],
  ) => Effect.Effect<ReadonlyArray<Loop>, RepositoryFailure | LeaseUnavailable>;
  readonly replace: (id: LoopId, loop: Loop) => Effect.Effect<Loop, MutationError>;
  readonly arm: (id: LoopId, at: number) => Effect.Effect<Loop, MutationError>;
  readonly setEnabled: (id: LoopId, enabled: boolean) => Effect.Effect<Loop, MutationError>;
  readonly claimNow: (
    id: LoopId,
    now: number,
    gate: Gate,
  ) => Effect.Effect<Occurrence, MutationError>;
  readonly claimDue: (
    now: number,
    gate: Gate,
    retention: Loop["retention"],
  ) => Effect.Effect<ReadonlyArray<Occurrence>, RepositoryFailure>;
};

export type SessionLoopPersistence = {
  readonly initial: ReadonlyArray<Loop>;
  readonly persist: (loops: ReadonlyArray<Loop>) => Effect.Effect<void, RepositoryFailure>;
};

const repositoryFailure =
  (operation: RepositoryFailure["operation"], message: string) => (cause: unknown) =>
    new RepositoryFailure({ operation, message, cause });

const decodeDurableFile = (encoded: string, filePath: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(DurableFile), {
    onExcessProperty: "error",
  })(encoded).pipe(
    Effect.map((file) => file.loops),
    Effect.mapError(repositoryFailure("load", `Invalid durable file ${filePath}`)),
  );

type RepositoryState =
  | { readonly _tag: "Inactive"; readonly loops: ReadonlyMap<LoopId, Loop> }
  | { readonly _tag: "Follower"; readonly loops: ReadonlyMap<LoopId, Loop> }
  | {
      readonly _tag: "Owner";
      readonly loops: ReadonlyMap<LoopId, Loop>;
      readonly ownershipScope: Scope.Closeable;
    };

export const makeLoopRepository = (
  cwd: string,
  config: LoopConfig,
  sessionPersistence?: SessionLoopPersistence,
): Effect.Effect<LoopRepository, RepositoryFailure, FileSystem | Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const repositoryScope = yield* Scope.Scope;
    const filePath = path.join(cwd, config.durableFilePath);
    const leasePath = `${filePath}.lease.sqlite`;
    const mutationLock = yield* Semaphore.make(1);

    const readDurable = Effect.gen(function* () {
      const loaded = new Map<LoopId, Loop>();
      const durableExists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(repositoryFailure("load", `Could not inspect ${filePath}`)));
      if (durableExists) {
        const durable = yield* Effect.gen(function* () {
          const encoded = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError(repositoryFailure("load", `Could not read ${filePath}`)));
          return yield* decodeDurableFile(encoded, filePath);
        });
        for (const loop of durable) loaded.set(loop.id, loop);
      }
      return loaded;
    });

    const loaded = new Map<LoopId, Loop>();
    for (const loop of sessionPersistence?.initial ?? []) {
      if (loop.retention !== "session") {
        return yield* new RepositoryFailure({
          operation: "load",
          message: `Session persistence contains project loop ${loop.id}`,
        });
      }
      loaded.set(loop.id, loop);
    }
    const state = yield* Ref.make<RepositoryState>({ _tag: "Inactive", loops: loaded });

    const attemptProjectOwnership = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current._tag === "Owner") return true;
      const ownershipScope = yield* Scope.fork(repositoryScope, "sequential");
      const acquired = yield* acquireCrossProcessLease(leasePath).pipe(
        Effect.provideService(Scope.Scope, ownershipScope),
        Effect.provideService(FileSystem, fs),
        Effect.provideService(Path, path),
        Effect.as(true as const),
        Effect.catchTag("LeaseUnavailable", () =>
          Scope.close(ownershipScope, Exit.succeed(undefined)).pipe(Effect.as(false as const)),
        ),
        Effect.mapError((cause) =>
          repositoryFailure("lease", `Could not acquire ${leasePath}`)(cause),
        ),
        Effect.onError((cause) => Scope.close(ownershipScope, Exit.failCause(cause))),
      );
      if (!acquired) {
        const durable = yield* readDurable;
        yield* Ref.set(state, {
          _tag: durable.size > 0 ? "Follower" : "Inactive",
          loops: current.loops,
        });
        return false;
      }
      const durable = yield* readDurable.pipe(
        Effect.onError((cause) => Scope.close(ownershipScope, Exit.failCause(cause))),
      );
      const merged = new Map(durable);
      for (const loop of current.loops.values()) {
        if (loop.retention === "project" || merged.has(loop.id)) {
          yield* Scope.close(ownershipScope, Exit.succeed(undefined));
          return yield* new RepositoryFailure({
            operation: "load",
            message: `Duplicate loop id ${loop.id}`,
          });
        }
        merged.set(loop.id, loop);
      }
      yield* Ref.set(state, { _tag: "Owner", loops: merged, ownershipScope });
      return true;
    });

    const initialDurable = yield* readDurable;
    if (initialDurable.size > 0) {
      yield* mutationLock.withPermits(1)(attemptProjectOwnership);
    }

    const stateForId = (id: LoopId) =>
      Effect.gen(function* () {
        let current = yield* Ref.get(state);
        if (!current.loops.has(id) && current._tag !== "Owner") {
          const durable = yield* readDurable;
          if (durable.has(id)) {
            yield* attemptProjectOwnership;
            current = yield* Ref.get(state);
          }
        }
        return current;
      });

    const persist = (next: ReadonlyMap<LoopId, Loop>) =>
      Effect.gen(function* () {
        const loops = [...next.values()].filter((loop) => loop.retention === "project");
        const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(DurableFile))({
          version: 2,
          loops,
        }).pipe(Effect.mapError(repositoryFailure("persist", `Could not encode ${filePath}`)));
        const temporary = `${filePath}.staging-${globalThis.crypto.randomUUID()}`;
        yield* fs
          .writeFileString(temporary, encoded, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(repositoryFailure("persist", `Could not stage ${filePath}`)));
        yield* fs
          .rename(temporary, filePath)
          .pipe(
            Effect.mapError(repositoryFailure("persist", `Could not replace ${filePath}`)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
      });

    const commit = (
      current: RepositoryState,
      next: ReadonlyMap<LoopId, Loop>,
      retention: Loop["retention"],
    ) =>
      Effect.gen(function* () {
        if (retention === "project") {
          if (current._tag === "Follower") {
            return yield* new LeaseUnavailable({
              message: "Another Pi session owns project-retained loops",
            });
          }
          if (current._tag === "Inactive") {
            return yield* new RepositoryFailure({
              operation: "lease",
              message: "Project mutation requires an owned lease",
            });
          }
          yield* persist(next);
        } else if (sessionPersistence) {
          yield* sessionPersistence.persist(
            [...next.values()].filter((loop) => loop.retention === "session"),
          );
        }
        if (current.loops === next) return;
        const hasProjectLoops = [...next.values()].some((loop) => loop.retention === "project");
        if (current._tag === "Owner" && !hasProjectLoops) {
          yield* Scope.close(current.ownershipScope, Exit.succeed(undefined));
          yield* Ref.set(state, { _tag: "Inactive", loops: next });
        } else {
          yield* Ref.set(state, { ...current, loops: next });
        }
      });

    const releaseEmptyOwnership = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (
        current._tag !== "Owner" ||
        [...current.loops.values()].some((loop) => loop.retention === "project")
      ) {
        return;
      }
      yield* Scope.close(current.ownershipScope, Exit.succeed(undefined));
      yield* Ref.set(state, { _tag: "Inactive", loops: current.loops });
    });

    const add = (loop: Loop) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (loop.retention === "project" && !(yield* attemptProjectOwnership)) {
            return yield* new LeaseUnavailable({
              message: "Another Pi session owns project-retained loops",
            });
          }
          const current = yield* Ref.get(state);
          if (current.loops.size >= config.maxLoops) {
            return yield* new CapacityExceeded({ maximum: config.maxLoops });
          }
          if (current.loops.has(loop.id)) {
            return yield* new LoopStateConflict({ id: loop.id, expected: "unused loop id" });
          }
          const next = new Map(current.loops);
          next.set(loop.id, loop);
          yield* commit(current, next, loop.retention);
        }).pipe(Effect.onError(() => releaseEmptyOwnership)),
      );

    const get = (id: LoopId) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const loop = current.loops.get(id);
          return loop ? Effect.succeed(loop) : Effect.fail(new LoopNotFound({ id }));
        }),
      );

    const remove = (id: LoopId) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* stateForId(id);
          const loop = current.loops.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const next = new Map(current.loops);
          next.delete(id);
          yield* commit(current, next, loop.retention);
          return loop;
        }),
      );

    const armLoop = (id: LoopId, at: number) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* stateForId(id);
          const loop = current.loops.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const armed = armTransition(loop, at);
          if (!armed) {
            return yield* new LoopStateConflict({ id, expected: "manual loop awaiting arm" });
          }
          const next = new Map(current.loops);
          next.set(id, armed);
          yield* commit(current, next, loop.retention);
          return armed;
        }),
      );

    const replace = (id: LoopId, updated: Loop) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* stateForId(id);
          const loop = current.loops.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          if (updated.id !== id || updated.retention !== loop.retention) {
            return yield* new LoopStateConflict({
              id,
              expected: "replacement with the same id and retention",
            });
          }
          const next = new Map(current.loops);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return updated;
        }),
      );

    const setEnabled = (id: LoopId, enabled: boolean) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* stateForId(id);
          const loop = current.loops.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const updated = { ...loop, enabled } as Loop;
          const next = new Map(current.loops);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return updated;
        }),
      );

    const claimNow = (id: LoopId, now: number, gate: Gate) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (gate === "closed")
            return yield* new LoopStateConflict({ id, expected: "idle session" });
          const current = yield* stateForId(id);
          const loop = current.loops.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          if (!loop.enabled)
            return yield* new LoopStateConflict({ id, expected: "enabled automation" });
          const cursor = loop.manualCursor + 1;
          const updated = { ...loop, manualCursor: cursor } as Loop;
          const next = new Map(current.loops);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return {
            id: `${id}:manual:${cursor}`,
            loopId: id,
            cursor,
            prompt: occurrencePrompt(loop),
            dueAt: now,
            claimedAt: now,
            trigger: "manual" as const,
          };
        }),
      );

    const removeAll = (retention: Loop["retention"]) =>
      mutationLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (retention === "project" && !(yield* attemptProjectOwnership)) {
              return yield* new LeaseUnavailable({
                message: "Another Pi session owns project-retained loops",
              });
            }
            const current = yield* Ref.get(state);
            const loops = [...current.loops.values()].filter(
              (loop) => loop.retention === retention,
            );
            const next = new Map(current.loops);
            for (const loop of loops) next.delete(loop.id);
            yield* commit(current, next, retention);
            return loops;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof LeaseUnavailable
              ? error
              : new RepositoryFailure({
                  operation: "persist",
                  message: "Could not remove all loops",
                  cause: error,
                }),
          ),
        );

    const claimDue = (now: number, gate: Gate, retention: Loop["retention"]) =>
      mutationLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (gate === "closed") return [];
            if (retention === "project") {
              const current = yield* Ref.get(state);
              if (current._tag !== "Owner") {
                const durable = yield* readDurable;
                if (durable.size === 0) {
                  if (current._tag !== "Inactive") {
                    yield* Ref.set(state, { _tag: "Inactive", loops: current.loops });
                  }
                  return [];
                }
                if (!(yield* attemptProjectOwnership)) return [];
              }
            }
            const current = yield* Ref.get(state);
            const next = new Map(current.loops);
            const occurrences: Array<Occurrence> = [];
            let touchesProject = false;
            for (const loop of current.loops.values()) {
              if (loop.retention !== retention) continue;
              const result = tick(loop, now, gate);
              if (!result.occurrence) continue;
              occurrences.push(result.occurrence);
              touchesProject = true;
              if (result.loop === undefined) next.delete(loop.id);
              else next.set(loop.id, result.loop);
            }
            if (touchesProject) yield* commit(current, next, retention);
            return occurrences;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof RepositoryFailure
              ? error
              : new RepositoryFailure({
                  operation: "persist",
                  message: "Could not claim due loops",
                  cause: error,
                }),
          ),
        );

    return {
      projectAccess: Ref.get(state).pipe(
        Effect.map((current) => current._tag.toLowerCase() as "inactive" | "owner" | "follower"),
      ),
      add,
      list: Ref.get(state).pipe(Effect.map((current) => [...current.loops.values()])),
      get,
      remove,
      removeAll,
      replace,
      arm: armLoop,
      setEnabled,
      claimNow,
      claimDue,
    };
  });
