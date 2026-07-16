import assert from "node:assert/strict";
import { run } from "./lib.mjs";

const branch = run("git", ["branch", "--show-current"], { capture: true }).trim();
assert.equal(branch, "main", "push:release only publishes main");
const sourceSha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();

run("node", ["tooling/release/container-preflight.mjs"]);

assert.equal(
  run("git", ["rev-parse", "HEAD"], { capture: true }).trim(),
  sourceSha,
  "HEAD changed after release preflight",
);
assert.equal(
  run("git", ["status", "--porcelain"], { capture: true }),
  "",
  "worktree changed after release preflight",
);
run("git", ["push", "-u", "origin", "main"]);
