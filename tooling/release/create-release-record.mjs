import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, suiteConfig } from "./lib.mjs";

const sourceSha = process.argv[2];
assert.match(sourceSha ?? "", /^[0-9a-f]{40}$/, "release record requires one source SHA");
assert.equal(
  run("git", ["rev-parse", "HEAD"], { capture: true }).trim(),
  sourceSha,
  "release record must be created on its source",
);

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.schemaVersion, 4);
assert.equal(candidate.sourceSha, sourceSha);
assert.equal(candidate.projection?.kind, "package-versions");
const packageIds = new Set(suiteConfig().packages.map(({ id }) => id));

for (const file of candidate.projection.changeFiles) rmSync(resolve(root, file));
run("git", ["add", "--", ...candidate.projection.files]);
const staged = run("git", ["diff", "--cached", "--name-only"], { capture: true })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();
assert.deepEqual(
  staged,
  [...candidate.projection.files].sort(),
  "release record staged unexpected files",
);

const commitArguments = [
  "commit",
  "-m",
  `chore(release): ${candidate.projection.releaseTag}`,
  "-m",
  `Release-Source: ${sourceSha}`,
];
for (const entry of candidate.projection.packages) {
  assert.ok(packageIds.has(entry.id), `candidate names unknown package ${entry.id}`);
  commitArguments.push("-m", `Release-Package: ${entry.id} ${entry.toVersion} ${entry.bump}`);
}
run("git", commitArguments);

for (const tag of [
  candidate.projection.releaseTag,
  ...candidate.projection.packages.map(({ tag }) => tag),
]) {
  run("git", ["tag", tag]);
}
process.stdout.write(`${candidate.projection.releaseTag}\n`);
