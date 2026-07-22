import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { acquireVerifyLease } from "./verify-lease.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry) throw new Error("verify must run through the repository package manager");

console.log("Waiting for the checkout-scoped Pipee verification lease...");
const release = await acquireVerifyLease(workspaceRoot);
console.log("Acquired the checkout-scoped Pipee verification lease.");

let child;
const forward = (signal) => {
  if (child?.exitCode === null) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

try {
  child = spawn(process.execPath, [packageManagerEntry, "run", "verify:exclusive"], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await release();
}
