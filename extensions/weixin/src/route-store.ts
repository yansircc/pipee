import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Path, Scope, Semaphore } from "effect";
import { RouteConflictError, RouteStoreError } from "./errors.ts";

export interface OutboundRoute {
  readonly accountId: string;
  readonly serverMessageId: string;
  readonly sourceSessionId: string;
  readonly clientId: string;
  readonly createdAt: number;
}

export interface RouteStore {
  readonly path: string;
  readonly withSendPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly record: (
    route: OutboundRoute,
  ) => Effect.Effect<void, RouteStoreError | RouteConflictError>;
  readonly resolve: (
    accountId: string,
    serverMessageId: string,
  ) => Effect.Effect<string | undefined, RouteStoreError>;
}

const storeError =
  (operation: RouteStoreError["operation"], path: string) =>
  (cause: unknown): RouteStoreError =>
    new RouteStoreError({ operation, path, cause });

export const makeRouteStore = (
  databasePath: string,
): Effect.Effect<RouteStore, RouteStoreError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs
      .makeDirectory(path.dirname(databasePath), { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(storeError("open", databasePath)));
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const value = new DatabaseSync(databasePath);
          value.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
          value.exec(`
            CREATE TABLE IF NOT EXISTS outbound_routes (
              account_id TEXT NOT NULL,
              server_message_id TEXT NOT NULL,
              source_session_id TEXT NOT NULL,
              client_id TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (account_id, server_message_id)
            ) STRICT;
            CREATE UNIQUE INDEX IF NOT EXISTS outbound_routes_client
              ON outbound_routes(account_id, client_id);
          `);
          return value;
        },
        catch: storeError("open", databasePath),
      }),
      (value) =>
        Effect.try({
          try: () => value.close(),
          catch: storeError("close", databasePath),
        }).pipe(Effect.ignore),
    );
    const lock = yield* Semaphore.make(1);
    const resolveUnlocked = (accountId: string, serverMessageId: string) =>
      Effect.try({
        try: () => {
          const row = database
            .prepare(
              "SELECT source_session_id FROM outbound_routes WHERE account_id = ? AND server_message_id = ?",
            )
            .get(accountId, serverMessageId) as { readonly source_session_id: string } | undefined;
          return row?.source_session_id;
        },
        catch: storeError("resolve", databasePath),
      });

    return {
      path: databasePath,
      withSendPermit: (effect) => lock.withPermits(1)(effect),
      resolve: (accountId, serverMessageId) => resolveUnlocked(accountId, serverMessageId),
      record: (route) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () =>
              database
                .prepare(
                  `INSERT OR IGNORE INTO outbound_routes
                      (account_id, server_message_id, source_session_id, client_id, created_at)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(
                  route.accountId,
                  route.serverMessageId,
                  route.sourceSessionId,
                  route.clientId,
                  route.createdAt,
                ),
            catch: storeError("record", databasePath),
          });
          const actual = yield* resolveUnlocked(route.accountId, route.serverMessageId);
          if (actual !== route.sourceSessionId) {
            return yield* new RouteConflictError({
              accountId: route.accountId,
              serverMessageId: route.serverMessageId,
              expectedSessionId: route.sourceSessionId,
              actualSessionId: actual ?? "missing",
            });
          }
        }),
    };
  });
