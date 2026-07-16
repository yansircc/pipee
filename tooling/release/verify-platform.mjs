import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";

run("node", ["tooling/release/verify-candidates.mjs"]);
const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.releasable, true, "platform witnesses require a releasable candidate");
for (const entry of suiteConfig().packages.filter(({ id }) => id !== "web")) {
  const artifact = candidate.artifacts[entry.id];
  assert.ok(artifact, `candidate is missing ${entry.id}`);
  run("pnpm", [
    "--filter",
    entry.name,
    "run",
    "release:platform-check",
    "--",
    resolve(root, "release/candidates", artifact.archive),
  ]);
}
process.stdout.write("Verified the exact Pi extension archives on this platform.\n");
