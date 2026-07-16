import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";
import { publishCandidateSet } from "./publication-orchestrator.mjs";
import { classifyRegistryLookup } from "./registry-state.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.schemaVersion, 3);
assert.equal(candidate.releasable, true, "refusing to publish a development candidate");

const registryIntegrity = (artifact) => {
  const result = spawnSync("npm", ["view", `${artifact.name}@${artifact.version}`, "dist.integrity", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return classifyRegistryLookup(result);
};

const artifacts = suiteConfig().packages.map((entry) => {
  const artifact = candidate.artifacts[entry.id];
  assert.ok(artifact, `candidate is missing ${entry.id}`);
  return artifact;
});

publishCandidateSet({
  artifacts,
  lookup: registryIntegrity,
  publish: (artifact) =>
    run("npm", [
      "publish",
      resolve(root, "release/candidates", artifact.archive),
      "--access",
      "public",
      "--provenance",
    ]),
});
process.stdout.write("Published or exactly reused all Suite archives.\n");
