import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extract } from "tar";
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const manifestPath = resolve(root, "release/candidate.json");
assert.equal(existsSync(manifestPath), true, "release/candidate.json is missing");
const candidate = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(candidate.schemaVersion, 5);
assert.equal(typeof candidate.releasable, "boolean");
if (candidate.sourceSha !== null) assert.match(candidate.sourceSha, /^[0-9a-f]{40}$/);
if (candidate.releasable) {
  const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  assert.equal(head, candidate.releaseSha, "candidate must be verified on its release commit");
  const record = parseReleaseRecord(
    run("git", ["show", "-s", "--format=%B", head], { capture: true }),
  );
  assert.ok(record, "candidate release commit has no release record");
  assert.equal(record.source, candidate.sourceSha, "release record owns another source");
  assert.equal(record.base, candidate.projection.baseSha, "release base projection drifted");
  assert.deepEqual(
    record.packages,
    candidate.projection.packages.map(({ id, toVersion, bump }) => ({
      id,
      version: toVersion,
      bump,
    })),
  );
  assertReleaseRecordCommit({
    record,
    parents: run("git", ["show", "-s", "--format=%P", head], { capture: true })
      .trim()
      .split(/\s+/),
    manifestVersions: Object.fromEntries(
      suiteConfig().packages.map(({ id, path }) => [
        id,
        JSON.parse(run("git", ["show", `${head}:${path}/package.json`], { capture: true })).version,
      ]),
    ),
    sourceManifestVersions: Object.fromEntries(
      suiteConfig().packages.map(({ id, path }) => [
        id,
        JSON.parse(run("git", ["show", `${record.source}:${path}/package.json`], { capture: true })).version,
      ]),
    ),
    packageIds: suiteConfig().packages.map(({ id }) => id),
    packageManifestPaths: Object.fromEntries(
      suiteConfig().packages.map(({ id, path }) => [id, `${path}/package.json`]),
    ),
    changedFiles: run("git", ["diff", "--name-status", record.source, head], { capture: true })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return { status, path };
      }),
  });
}
if (candidate.projection !== undefined) {
  assert.equal(candidate.projection.kind, "release-record");
  assert.equal(candidate.projection.releaseSha, candidate.releaseSha);
  assert.match(candidate.projection.releaseTag, /^release-[0-9a-f]{12}$/);
}
const projectedIds =
  candidate.projection?.packages.map(({ id }) => id) ?? Object.keys(candidate.artifacts);
assert.deepEqual(Object.keys(candidate.artifacts).sort(), [...projectedIds].sort());
for (const entry of suiteConfig().packages.filter(({ id }) => projectedIds.includes(id))) {
  const artifact = candidate.artifacts[entry.id];
  assert.equal(artifact.name, entry.name);
  const projected = candidate.projection?.packages.find(({ id }) => id === entry.id);
  if (projected) assert.equal(artifact.version, projected.toVersion);
  const archive = resolve(root, "release/candidates", artifact.archive);
  assert.equal(existsSync(archive), true, `${entry.id} archive is missing`);
  assert.equal(
    sha512Integrity(readFileSync(archive)),
    artifact.integrity,
    `${entry.id} archive changed`,
  );
  const stagingDirectory = mkdtempSync(join(tmpdir(), "pi-suite-verify-"));
  try {
    await extract({ file: archive, cwd: stagingDirectory });
    const packageDirectory = join(stagingDirectory, "package");
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    for (const privatePackage of ["@pipee/companion-contracts", "@pipee/host-runtime"]) {
      assert.equal(
        manifest.dependencies?.[privatePackage],
        undefined,
        `${entry.id} archive has a runtime dependency on ${privatePackage}`,
      );
    }
    const pending = [packageDirectory];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) pending.push(path);
        else if (/\.(?:c?js|mjs)$/.test(name)) {
          const source = readFileSync(path, "utf8");
          assert.doesNotMatch(
            source,
            /(?:from\s*|import\s*\()\s*["']@pipee\/companion-contracts/,
            `${entry.id} archive has a runtime import of the private contracts package`,
          );
        }
      }
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  if (entry.browserExtension) {
    assert.equal(
      artifact.browserExtensionVersion,
      artifact.version,
      "pi-chrome npm and browser extension versions must match",
    );
  }
}
process.stdout.write(`Verified ${projectedIds.length} immutable candidate archives.\n`);
