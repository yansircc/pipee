import { DatabaseSync } from "node:sqlite";

interface SqliteFailure {
  readonly errcode?: unknown;
}

export const isSqliteBusy = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as SqliteFailure).errcode === 5;

export const openSqliteDatabase = (path: string): DatabaseSync => new DatabaseSync(path);

export const beginWriteLease = (database: DatabaseSync): DatabaseSync => {
  // A lease requires one writer, not exclusion of readers. IMMEDIATE acquires SQLite's unique
  // reserved write lock directly, so concurrent first openers cannot all fail while upgrading
  // their own shared locks to EXCLUSIVE.
  database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  return database;
};

export const closeSqliteDatabase = (database: DatabaseSync): void => database.close();

export const rollbackExclusiveLease = (database: DatabaseSync): void => database.exec("ROLLBACK");
