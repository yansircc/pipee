import { Data, Effect, FileSystem, Path, Scope } from "effect";
import {
  beginWriteLease,
  closeSqliteDatabase,
  isSqliteBusy,
  openSqliteDatabase,
  rollbackExclusiveLease,
} from "./sqlite-lease.ts";

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

const close = (database: ReturnType<typeof openSqliteDatabase>) =>
  Effect.try({
    try: () => closeSqliteDatabase(database),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const release = (database: ReturnType<typeof openSqliteDatabase>) =>
  Effect.try({
    try: () => rollbackExclusiveLease(database),
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
      try: () => openSqliteDatabase(path),
      catch: (cause) => new LeaseFailure({ operation: "open", path, cause }),
    });
    const acquire = Effect.flatMap(open, (database) =>
      Effect.try({
        try: () => {
          return beginWriteLease(database);
        },
        catch: (cause) =>
          isSqliteBusy(cause)
            ? new LeaseUnavailable({ path })
            : new LeaseFailure({ operation: "acquire", path, cause }),
      }).pipe(Effect.tapError(() => close(database))),
    );

    return yield* Effect.acquireRelease(acquire, release).pipe(Effect.map(() => ({ path })));
  }).pipe(Effect.withSpan("pipee.lease.acquire"));
