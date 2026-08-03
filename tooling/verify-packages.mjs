import { fileURLToPath } from "node:url";
import process from "node:process";
import { packageVerificationTasks } from "./verification-plan.mjs";
import { runVerificationPool, verificationJobs } from "./verification-pool.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry)
  throw new Error("package verification must run through the repository package manager");

const jobs = verificationJobs();
const tasks = packageVerificationTasks({ workspaceRoot, packageManagerEntry });
process.stdout.write(`Running ${tasks.length} package verification tasks with ${jobs} workers.\n`);
await runVerificationPool(tasks, { jobs });
