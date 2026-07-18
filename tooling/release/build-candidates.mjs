import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const development = process.argv.includes("--development");
const releaseIndex = process.argv.indexOf("--release-sha");
const releaseSha = releaseIndex === -1 ? null : process.argv[releaseIndex + 1];
if (releaseIndex !== -1 && !releaseSha) throw new Error("--release-sha requires a commit");
assert.equal(
  process.argv.includes("--existing-release"),
  false,
  "an existing release must restore its witnessed candidate, never rebuild it",
);
const candidateDirectory = resolve(root, "release/candidates");
const candidateManifestPath = resolve(root, "release/candidate.json");
let headSha = null;
try {
  headSha = run("git", ["rev-parse", "--verify", "-q", "HEAD"], { capture: true }).trim();
} catch (error) {
  if (!development) throw error;
}
const dirtyFiles = run("git", ["status", "--porcelain"], { capture: true })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(3))
  .sort();
let record;
let selectedEntries;
if (releaseSha) {
  assert.match(releaseSha, /^[0-9a-f]{40}$/, "release SHA must be a full commit SHA");
  assert.equal(headSha, releaseSha, "candidate must remain on its release commit");
  assert.deepEqual(dirtyFiles, [], "release candidate worktree must remain clean");
  record = parseReleaseRecord(run("git", ["show", "-s", "--format=%B", releaseSha], { capture: true }));
  assert.ok(record, "release candidate commit has no release record");
  const parents = run("git", ["show", "-s", "--format=%P", releaseSha], { capture: true })
    .trim()
    .split(/\s+/);
  const config = suiteConfig();
  const manifests = Object.fromEntries(
    config.packages.map((entry) => [
      entry.id,
      JSON.parse(readFileSync(resolve(root, entry.path, "package.json"), "utf8")).version,
    ]),
  );
  assertReleaseRecordCommit({
    record,
    parents,
    manifestVersions: manifests,
    sourceManifestVersions: Object.fromEntries(
      config.packages.map((entry) => [
        entry.id,
        JSON.parse(run("git", ["show", `${record.source}:${entry.path}/package.json`], { capture: true })).version,
      ]),
    ),
    packageIds: config.packages.map(({ id }) => id),
    packageManifestPaths: Object.fromEntries(
      config.packages.map(({ id, path }) => [id, `${path}/package.json`]),
    ),
    changedFiles: run("git", ["diff", "--name-status", record.source, releaseSha], {
      capture: true,
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return { status, path };
      }),
  });
  selectedEntries = record.packages.map((projected) => {
    const entry = config.packages.find(({ id }) => id === projected.id);
    assert.ok(entry, `release record names unknown package ${projected.id}`);
    return { ...entry, bump: projected.bump, releaseVersion: projected.version };
  });
} else if ((!headSha || dirtyFiles.length > 0) && !development) {
  throw new Error("release candidates require a clean committed worktree");
} else {
  selectedEntries = suiteConfig().packages;
}
const sourceSha = record?.source ?? headSha;

rmSync(candidateDirectory, { recursive: true, force: true });
mkdirSync(candidateDirectory, { recursive: true });

const artifacts = {};
for (const entry of selectedEntries) {
  const packageDirectory = resolve(root, entry.path);
  if (entry.prepareScript) run("pnpm", ["run", entry.prepareScript], { cwd: packageDirectory });
  const before = new Set(readdirSync(candidateDirectory));
  run("pnpm", ["pack", "--pack-destination", candidateDirectory], {
    cwd: packageDirectory,
  });
  const created = readdirSync(candidateDirectory).filter(
    (file) => !before.has(file) && file.endsWith(".tgz"),
  );
  assert.equal(created.length, 1, `${entry.id} must emit one archive`);
  const archive = join(candidateDirectory, created[0]);
  const packageManifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  artifacts[entry.id] = {
    name: entry.name,
    version: packageManifest.version,
    archive: basename(archive),
    integrity: sha512Integrity(readFileSync(archive)),
    ...(entry.browserExtension
      ? {
          browserExtensionVersion: JSON.parse(
            readFileSync(resolve(packageDirectory, entry.browserExtension), "utf8"),
          ).version,
          protocolCompatibilityVerifiedBy: "@yansircc/pi-chrome release:archive-check",
        }
      : {}),
  };
}

assert.ok(Object.keys(artifacts).length > 0, "candidate requires at least one selected package");

const projection = record
  ? {
      kind: "release-record",
      releaseSha,
      baseSha: record.base,
      releaseTag: record.tag,
      packages: selectedEntries.map((entry) => {
        const path = `${entry.path}/package.json`;
        const fromVersion = JSON.parse(
          run("git", ["show", `${record.source}:${path}`], { capture: true }),
        ).version;
        const toVersion = artifacts[entry.id].version;
        assert.equal(
          toVersion,
          entry.releaseVersion,
          `${entry.id} archive version does not match its release record`,
        );
        return {
          id: entry.id,
          name: entry.name,
          bump: entry.bump,
          fromVersion,
          toVersion,
          tag: `${entry.name.split("/").at(-1)}-v${toVersion}`,
        };
      }),
    }
  : undefined;

writeFileSync(
  candidateManifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 5,
      sourceSha,
      releaseSha,
      releasable: releaseSha !== null,
      projection,
      artifacts,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `${development && dirtyFiles.length > 0 ? "Development" : "Release"} candidate written to release/candidate.json\n`,
);
