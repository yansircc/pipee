import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { acquireCheckoutLease } from "./verify-lease.mjs";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const [leaseName, command, ...rawArguments] = process.argv.slice(2);
if (!leaseName || !command) {
  throw new Error("usage: run-with-checkout-lease.mjs <lease-name> <command> [...arguments]");
}
const args = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;

console.log(`Waiting for the checkout-scoped Pipee ${leaseName} lease...`);
const release = await acquireCheckoutLease(workspaceRoot, leaseName);
console.log(`Acquired the checkout-scoped Pipee ${leaseName} lease.`);

let child;
const forward = (signal) => {
  if (child?.exitCode === null) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

try {
  child = spawn(command, args, {
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
