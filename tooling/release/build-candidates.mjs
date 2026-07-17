import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs";
import { readReleasePlan } from "./release-plan.mjs";
import { bumpVersion } from "./version.mjs";

const development = process.argv.includes("--development");
const preparedSourceIndex = process.argv.indexOf("--prepared-source");
const preparedSource = preparedSourceIndex === -1 ? null : process.argv[preparedSourceIndex + 1];
if (preparedSourceIndex !== -1 && !preparedSource) {
  throw new Error("--prepared-source requires a source commit");
}
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
const plan = readReleasePlan();
const selectedEntries = preparedSource ? plan.packages : suiteConfig().packages;
const changedManifestFiles = selectedEntries.map(({ path }) => `${path}/package.json`).sort();
if (preparedSource) {
  assert.match(preparedSource, /^[0-9a-f]{40}$/, "prepared source must be a full commit SHA");
  assert.equal(headSha, preparedSource, "prepared candidate must remain on its source commit");
  assert.deepEqual(
    dirtyFiles,
    changedManifestFiles,
    "prepared candidate may change only selected package version manifests",
  );
} else if ((!headSha || dirtyFiles.length > 0) && !development) {
  throw new Error("release candidates require a clean committed worktree");
}
const sourceSha = preparedSource ?? headSha;

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

const projection = preparedSource
  ? {
      kind: "package-versions",
      releaseTag: `release-${preparedSource.slice(0, 12)}`,
      changeFiles: plan.files,
      files: [...changedManifestFiles, ...plan.files].sort(),
      packages: selectedEntries.map((entry) => {
        const path = `${entry.path}/package.json`;
        const fromVersion = JSON.parse(
          run("git", ["show", `${preparedSource}:${path}`], { capture: true }),
        ).version;
        const toVersion = artifacts[entry.id].version;
        assert.equal(
          toVersion,
          bumpVersion(fromVersion, entry.bump),
          `${entry.id} candidate version does not match its requested bump`,
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
      schemaVersion: 4,
      sourceSha,
      releasable: sourceSha !== null && (preparedSource !== null || dirtyFiles.length === 0),
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
