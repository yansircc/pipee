import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs";

const development = process.argv.includes("--development");
const preparedSourceIndex = process.argv.indexOf("--prepared-source");
const preparedSource = preparedSourceIndex === -1 ? null : process.argv[preparedSourceIndex + 1];
const existingSourceIndex = process.argv.indexOf("--existing-release");
const existingSource = existingSourceIndex === -1 ? null : process.argv[existingSourceIndex + 1];
if (preparedSourceIndex !== -1 && !preparedSource) {
  throw new Error("--prepared-source requires a source commit");
}
if (existingSourceIndex !== -1 && !existingSource) {
  throw new Error("--existing-release requires a source commit");
}
assert.equal(
  preparedSource === null || existingSource === null,
  true,
  "candidate has exactly one release projection mode",
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
const releaseFiles = [
  "package.json",
  ...suiteConfig().packages.map(({ path }) => `${path}/package.json`),
].sort();
if (preparedSource) {
  assert.match(preparedSource, /^[0-9a-f]{40}$/, "prepared source must be a full commit SHA");
  assert.equal(headSha, preparedSource, "prepared candidate must remain on its source commit");
  assert.deepEqual(
    dirtyFiles,
    releaseFiles,
    "prepared candidate may change only Suite version manifests",
  );
} else if (existingSource) {
  assert.match(existingSource, /^[0-9a-f]{40}$/, "existing source must be a full commit SHA");
  assert.deepEqual(dirtyFiles, [], "existing release candidate must use its clean release commit");
  const message = run("git", ["show", "-s", "--format=%B", headSha], { capture: true });
  assert.ok(
    message.split(/\r?\n/).includes(`Release-Source: ${existingSource}`),
    "existing release commit does not own the requested source",
  );
} else if ((!headSha || dirtyFiles.length > 0) && !development) {
  throw new Error("release candidates require a clean committed worktree");
}
const sourceSha = preparedSource ?? existingSource ?? headSha;

rmSync(candidateDirectory, { recursive: true, force: true });
mkdirSync(candidateDirectory, { recursive: true });

const artifacts = {};
for (const entry of suiteConfig().packages) {
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

const versions = Object.values(artifacts).map(({ version }) => version);
assert.ok(versions.length > 0);
assert.ok(
  versions.every((version) => version === versions[0]),
  "candidate archives must share one Suite version",
);

writeFileSync(
  candidateManifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 2,
      sourceSha,
      releasable:
        sourceSha !== null &&
        (preparedSource !== null || existingSource !== null || dirtyFiles.length === 0),
      releaseCommit: existingSource ? headSha : undefined,
      projection:
        preparedSource || existingSource
          ? {
              kind: "suite-version",
              files: releaseFiles,
              version: versions[0],
            }
          : undefined,
      artifacts,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `${development && dirtyFiles.length > 0 ? "Development" : "Release"} candidate written to release/candidate.json\n`,
);
