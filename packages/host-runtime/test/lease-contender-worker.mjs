import {
  beginWriteLease,
  closeSqliteDatabase,
  isSqliteBusy,
  openSqliteDatabase,
} from "../src/sqlite-lease.ts";

const [path] = process.argv.slice(2);
if (path === undefined) process.exit(64);

const contend = () => {
  const database = openSqliteDatabase(path);
  try {
    beginWriteLease(database);
    process.stdout.write("acquired\n");
    setInterval(() => database.exec("SELECT 1"), 2_147_483_647);
  } catch (cause) {
    closeSqliteDatabase(database);
    if (!isSqliteBusy(cause)) throw cause;
    process.stdout.write("unavailable\n", () => process.disconnect());
  }
};

process.send?.("ready");
process.once("message", (message) => {
  if (message === "acquire") contend();
  else process.exit(64);
});
