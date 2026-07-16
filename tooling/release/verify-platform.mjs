import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";

run("node", ["tooling/release/verify-candidates.mjs"]);
const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.releasable, true, "platform witnesses require a releasable candidate");
for (const entry of suiteConfig().packages) {
  const artifact = candidate.artifacts[entry.id];
  assert.ok(artifact, `candidate is missing ${entry.id}`);
  const script = entry.platformChecks?.[process.platform] ?? entry.platformChecks?.default;
  assert.equal(typeof script, "string", `${entry.id} has no platform witness for ${process.platform}`);
  run("pnpm", [
    "--filter",
    entry.name,
    "run",
    script,
    "--",
    resolve(root, "release/candidates", artifact.archive),
  ]);
}
process.stdout.write("Verified every exact Suite archive on this platform.\n");
