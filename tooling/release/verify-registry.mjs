import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
const directory = mkdtempSync(join(tmpdir(), "pi-suite-registry-"));
try {
  writeFileSync(join(directory, "package.json"), '{"private":true}\n');
  const coordinates = suiteConfig().packages.map(({ id }) => {
    const artifact = candidate.artifacts[id];
    assert.ok(artifact, `candidate is missing ${id}`);
    return `${artifact.name}@${artifact.version}`;
  });
  run("npm", ["install", "--ignore-scripts", ...coordinates], { cwd: directory });
  for (const entry of suiteConfig().packages) {
    const installed = JSON.parse(
      readFileSync(
        join(directory, "node_modules", ...entry.name.split("/"), "package.json"),
        "utf8",
      ),
    );
    assert.equal(installed.version, candidate.artifacts[entry.id].version);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.stdout.write("Verified one public registry install of the unified Suite version.\n");
