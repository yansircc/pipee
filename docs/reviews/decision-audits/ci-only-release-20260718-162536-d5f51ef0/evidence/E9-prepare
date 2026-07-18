import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, root, run, suiteConfig } from "./lib.mjs";
import { readReleasePlan } from "./release-plan.mjs";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";
import { bumpVersion } from "./version.mjs";

const sourceSha = process.argv[2];
if (!sourceSha) throw new Error("usage: prepare.mjs <source-sha>");
assert.match(sourceSha, /^[0-9a-f]{40}$/, "release source must be a full commit SHA");

const git = (args, options = {}) => run("git", args, { capture: true, ...options }).trim();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const config = suiteConfig();
const packageIds = config.packages.map(({ id }) => id);
const manifestPath = (entry) => `${entry.path}/package.json`;
const packageManifestPaths = Object.fromEntries(
  config.packages.map((entry) => [entry.id, manifestPath(entry)]),
);
const changedFilesAt = (commit) =>
  git(["diff-tree", "--no-commit-id", "--name-status", "-r", commit])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status, path };
    });
const manifestVersionsAt = (commit) =>
  Object.fromEntries(
    config.packages.map((entry) => [
      entry.id,
      JSON.parse(git(["show", `${commit}:${manifestPath(entry)}`])).version,
    ]),
  );
const releaseCommits = () => {
  const records = git(["log", "origin/main", "--format=%H%x1f%P%x1f%B%x1e"]);
  return records.split("\x1e").flatMap((raw) => {
    const [commit, rawParents = "", message = ""] = raw.trim().split("\x1f", 3);
    if (!commit) return [];
    const record = parseReleaseRecord(message);
    if (record === undefined) return [];
    assertReleaseRecordCommit({
      record,
      parents: rawParents.split(/\s+/).filter(Boolean),
      manifestVersions: manifestVersionsAt(commit),
      packageIds,
      packageManifestPaths,
      changedFiles: changedFilesAt(commit),
    });
    return [{ commit, record }];
  });
};

git(["cat-file", "-e", `${sourceSha}^{commit}`]);
const releases = releaseCommits();
const matching = releases.filter(({ record }) => record.source === sourceSha);
if (matching.length > 1) throw new Error("one source commit has multiple release records");
const existing = matching[0];
if (existing) {
  git(["checkout", "--detach", existing.commit]);
} else {
  if (git(["rev-parse", "HEAD"]) !== sourceSha) {
    throw new Error("new release preparation must run from the source commit");
  }
  if (
    process.env.PI_SUITE_RELEASE_PREVIEW !== "1" &&
    git(["rev-parse", "origin/main"]) !== sourceSha
  ) {
    throw new Error(
      "release source is no longer origin/main; wait for each main release before pushing the next source",
    );
  }
}

const pending = existing ? null : readReleasePlan();
if (!existing && releases[0]) {
  const expectedVersions = manifestVersionsAt(releases[0].commit);
  for (const entry of config.packages) {
    const currentVersion = readJson(manifestPath(entry)).version;
    if (currentVersion !== expectedVersions[entry.id]) {
      throw new Error(
        `${entry.id} version is CI-owned; expected ${expectedVersions[entry.id]}, received ${currentVersion}`,
      );
    }
  }
}
const selected = existing
  ? existing.record.packages.map((released) => {
      const entry = config.packages.find(({ id }) => id === released.id);
      assert.ok(entry, `existing release names unknown package ${released.id}`);
      return { ...entry, bump: released.bump, version: released.version };
    })
  : pending.packages.map((entry) => {
      const path = manifestPath(entry);
      const manifest = readJson(path);
      const version = bumpVersion(manifest.version, entry.bump);
      manifest.version = version;
      writeJson(resolve(root, path), manifest);
      return { ...entry, version };
    });

const releaseTag = `release-${sourceSha.slice(0, 12)}`;
const result = {
  mode: existing ? "existing" : selected.length === 0 ? "none" : "new",
  sourceSha,
  releaseTag,
  packages: selected.map(({ id, name, bump, version }) => ({ id, name, bump, version })),
  releaseFiles: [...selected.map((entry) => manifestPath(entry)), ...(pending?.files ?? [])],
  changeFiles: pending?.files ?? [],
  packageTags: selected.map(({ name, version }) => `${name.split("/").at(-1)}-v${version}`),
  existingCommit: existing?.commit,
};

if (!existing) {
  for (const tag of [releaseTag, ...result.packageTags]) {
    if (git(["tag", "--list", tag]) === tag) throw new Error(`release tag already exists: ${tag}`);
  }
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `mode=${result.mode}`,
      `release_tag=${result.releaseTag}`,
      `release_count=${result.packages.length}`,
    ].join("\n") + "\n",
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
