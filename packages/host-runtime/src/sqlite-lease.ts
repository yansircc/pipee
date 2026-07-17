import { DatabaseSync } from "node:sqlite";

interface SqliteFailure {
  readonly errcode?: unknown;
}

export const isSqliteBusy = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as SqliteFailure).errcode === 5;

export const openSqliteDatabase = (path: string): DatabaseSync => new DatabaseSync(path);

export const beginExclusiveLease = (database: DatabaseSync): DatabaseSync => {
  database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  return database;
};

export const closeSqliteDatabase = (database: DatabaseSync): void => database.close();

export const rollbackExclusiveLease = (database: DatabaseSync): void => database.exec("ROLLBACK");
