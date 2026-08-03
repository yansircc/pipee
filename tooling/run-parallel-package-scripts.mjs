import process from "node:process";
import { runVerificationPool } from "./verification-pool.mjs";

const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry)
  throw new Error("package scripts must run through the repository package manager");

const scripts = process.argv.slice(2);
if (scripts.length < 2) throw new Error("at least two package scripts are required");
for (const script of scripts) {
  if (!/^[a-z0-9][a-z0-9:-]*$/.test(script)) throw new Error(`invalid package script: ${script}`);
}

await runVerificationPool(
  scripts.map((script) => ({
    id: `script:${script}`,
    command: process.execPath,
    arguments: [packageManagerEntry, "run", script],
    cwd: process.cwd(),
  })),
  { jobs: scripts.length },
);
