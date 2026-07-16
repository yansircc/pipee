import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";
import {
  classifyRegistryLookup,
  publicationDecision,
  requireRegistryIntegrity,
} from "./registry-state.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.schemaVersion, 3);
assert.equal(candidate.releasable, true, "refusing to publish a development candidate");

const registryIntegrity = (name, version) => {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return classifyRegistryLookup(result);
};

for (const entry of suiteConfig().packages) {
  const artifact = candidate.artifacts[entry.id];
  assert.ok(artifact, `candidate is missing ${entry.id}`);
  const decision = publicationDecision(
    registryIntegrity(artifact.name, artifact.version),
    artifact.integrity,
  );
  if (decision._tag === "Publish") {
    run("npm", [
      "publish",
      resolve(root, "release/candidates", artifact.archive),
      "--access",
      "public",
      "--provenance",
    ]);
  }
  requireRegistryIntegrity(
    registryIntegrity(artifact.name, artifact.version),
    artifact.integrity,
  );
}
process.stdout.write("Published or exactly reused all Suite archives.\n");
