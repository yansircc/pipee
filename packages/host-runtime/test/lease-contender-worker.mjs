import {
  beginExclusiveLease,
  closeSqliteDatabase,
  isSqliteBusy,
  openSqliteDatabase,
} from "../src/sqlite-lease.ts";

const [path] = process.argv.slice(2);
if (path === undefined) process.exit(64);

let _heldDatabase;
const contend = () => {
  const database = openSqliteDatabase(path);
  try {
    beginExclusiveLease(database);
    _heldDatabase = database;
    process.stdout.write("acquired\n");
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
