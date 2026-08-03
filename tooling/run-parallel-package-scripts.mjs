import process from "node:process";
import { runVerificationPool } from "./verification-pool.mjs";

const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry)
  throw new Error("package scripts must run through the repository package manager");

const arguments_ = process.argv.slice(2);
const jobsFlag = arguments_[0] === "--jobs";
const jobs = jobsFlag ? Number(arguments_[1]) : undefined;
if (jobsFlag && (!Number.isSafeInteger(jobs) || jobs < 1)) {
  throw new Error("--jobs must be a positive integer");
}
const scripts = arguments_.slice(jobsFlag ? 2 : 0);
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
  { jobs: jobs ?? scripts.length },
);
