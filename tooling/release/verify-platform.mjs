import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, pipeeConfig } from "./lib.mjs";
import { runVerificationPool } from "../verification-pool.mjs";

run("node", ["tooling/release/verify-candidates.mjs"]);
const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.releasable, true, "platform witnesses require a releasable candidate");
const tasks = [];
for (const entry of pipeeConfig().packages) {
  const artifact = candidate.artifacts[entry.id];
  if (!artifact) continue;
  const script = entry.platformChecks?.[process.platform] ?? entry.platformChecks?.default;
  assert.equal(
    typeof script,
    "string",
    `${entry.id} has no platform witness for ${process.platform}`,
  );
  tasks.push({
    id: `platform:${entry.id}`,
    command: "pnpm",
    arguments: [
      "--filter",
      entry.name,
      "run",
      script,
      "--",
      resolve(root, "release/candidates", artifact.archive),
    ],
    cwd: root,
  });
}
await runVerificationPool(tasks, { jobs: process.platform === "darwin" ? 2 : 1 });
process.stdout.write("Verified every selected exact archive on this platform.\n");
