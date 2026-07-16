import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.schemaVersion, 2);
assert.equal(candidate.releasable, true, "refusing to publish a development candidate");

const registryIntegrity = (name, version) => {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/E404|is not in this registry/i.test(result.stderr)) return undefined;
  process.stderr.write(result.stderr);
  throw new Error(`could not read ${name}@${version} from npm`);
};

for (const entry of suiteConfig().packages) {
  const artifact = candidate.artifacts[entry.id];
  assert.ok(artifact, `candidate is missing ${entry.id}`);
  const existing = registryIntegrity(artifact.name, artifact.version);
  if (existing === undefined) {
    run("npm", [
      "publish",
      resolve(root, "release/candidates", artifact.archive),
      "--access",
      "public",
      "--provenance",
    ]);
  } else {
    assert.equal(
      existing,
      artifact.integrity,
      `${artifact.name}@${artifact.version} exists with different bytes`,
    );
  }
  assert.equal(
    registryIntegrity(artifact.name, artifact.version),
    artifact.integrity,
    `${artifact.name}@${artifact.version} registry integrity mismatch`,
  );
}
process.stdout.write("Published or exactly reused all Suite archives.\n");
