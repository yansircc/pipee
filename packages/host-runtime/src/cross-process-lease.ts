import { DatabaseSync } from "node:sqlite";
import { Data, Effect, FileSystem, Path, Scope } from "effect";

export class LeaseUnavailable extends Data.TaggedError("LeaseUnavailable")<{
  readonly path: string;
}> {}

export class LeaseFailure extends Data.TaggedError("LeaseFailure")<{
  readonly operation: "open" | "acquire";
  readonly path: string;
  readonly cause: unknown;
}> {}

export interface LeaseHandle {
  readonly path: string;
}

interface SqliteFailure {
  readonly errcode?: unknown;
}

const isBusy = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as SqliteFailure).errcode === 5;

const close = (database: DatabaseSync) =>
  Effect.try({
    try: () => database.close(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const release = (database: DatabaseSync) =>
  Effect.try({
    try: () => database.exec("ROLLBACK"),
    catch: () => undefined,
  }).pipe(Effect.ignore, Effect.andThen(close(database)));

export const acquireCrossProcessLease = (
  leasePath: string,
): Effect.Effect<
  LeaseHandle,
  LeaseUnavailable | LeaseFailure,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const path = pathService.resolve(leasePath);
    yield* fs
      .makeDirectory(pathService.dirname(path), { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => new LeaseFailure({ operation: "open", path, cause })));
    const open = Effect.try({
      try: () => new DatabaseSync(path),
      catch: (cause) => new LeaseFailure({ operation: "open", path, cause }),
    });
    const acquire = Effect.flatMap(open, (database) =>
      Effect.try({
        try: () => {
          database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
          return database;
        },
        catch: (cause) =>
          isBusy(cause)
            ? new LeaseUnavailable({ path })
            : new LeaseFailure({ operation: "acquire", path, cause }),
      }).pipe(Effect.tapError(() => close(database))),
    );

    return yield* Effect.acquireRelease(acquire, release).pipe(Effect.map(() => ({ path })));
  }).pipe(Effect.withSpan("pi_suite.lease.acquire"));
