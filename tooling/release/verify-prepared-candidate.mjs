import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, root, suiteConfig } from "./lib.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.schemaVersion, 4);
assert.equal(candidate.projection?.kind, "package-versions");

for (const projected of candidate.projection.packages) {
  const entry = suiteConfig().packages.find(({ id }) => id === projected.id);
  assert.ok(entry, `candidate names unknown package ${projected.id}`);
  assert.equal(
    readJson(`${entry.path}/package.json`).version,
    projected.toVersion,
    `${projected.id} prepared version differs from verified candidate`,
  );
}
process.stdout.write("Prepared manifests match every selected candidate version.\n");
