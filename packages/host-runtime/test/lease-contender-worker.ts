import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect } from "effect";
import {
  beginExclusiveLease,
  closeSqliteDatabase,
  isSqliteBusy,
  openSqliteDatabase,
  rollbackExclusiveLease,
} from "../src/sqlite-lease.ts";

const [path] = process.argv.slice(2);
if (path === undefined) process.exit(64);

class WorkerLeaseFailure extends Data.TaggedError("WorkerLeaseFailure")<{
  readonly cause: unknown;
}> {}

const close = (database: ReturnType<typeof openSqliteDatabase>) =>
  Effect.try({
    try: () => closeSqliteDatabase(database),
    catch: (cause) => new WorkerLeaseFailure({ cause }),
  }).pipe(Effect.ignore);

const release = (database: ReturnType<typeof openSqliteDatabase>) =>
  Effect.try({
    try: () => rollbackExclusiveLease(database),
    catch: (cause) => new WorkerLeaseFailure({ cause }),
  }).pipe(Effect.ignore, Effect.andThen(close(database)));

const acquire = Effect.try({
  try: () => openSqliteDatabase(path),
  catch: (cause) => new WorkerLeaseFailure({ cause }),
}).pipe(
  Effect.flatMap((database) =>
    Effect.try({
      try: () => beginExclusiveLease(database),
      catch: (cause) => new WorkerLeaseFailure({ cause }),
    }).pipe(Effect.tapError(() => close(database))),
  ),
);

const program = Effect.acquireRelease(acquire, release).pipe(
  Effect.tap(() => Effect.sync(() => process.stdout.write("acquired\n"))),
  Effect.andThen(Effect.never),
  Effect.catchIf(
    (failure) => isSqliteBusy(failure.cause),
    () => Effect.sync(() => process.stdout.write("unavailable\n")),
  ),
  Effect.scoped,
);

const triggered = Effect.callback<void>((resume) => {
  process.once("message", (message) => {
    resume(message === "acquire" ? Effect.void : Effect.die("invalid contender command"));
  });
});

process.send?.("ready");
NodeRuntime.runMain(Effect.andThen(triggered, program));
