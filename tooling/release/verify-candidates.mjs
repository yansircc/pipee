import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extract } from "tar";
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs";

const manifestPath = resolve(root, "release/candidate.json");
assert.equal(existsSync(manifestPath), true, "release/candidate.json is missing");
const candidate = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(candidate.schemaVersion, 2);
assert.equal(typeof candidate.releasable, "boolean");
if (candidate.sourceSha !== null) assert.match(candidate.sourceSha, /^[0-9a-f]{40}$/);
if (candidate.releasable) {
  assert.ok(
    [candidate.sourceSha, candidate.releaseCommit].includes(
      run("git", ["rev-parse", "HEAD"], { capture: true }).trim(),
    ),
    "candidate is not being verified from its source or release commit",
  );
}
if (candidate.projection !== undefined) {
  assert.equal(candidate.projection.kind, "suite-version");
  assert.match(candidate.projection.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.deepEqual(
    [...candidate.projection.files].sort(),
    ["package.json", ...suiteConfig().packages.map(({ path }) => `${path}/package.json`)].sort(),
  );
}
const suiteVersions = new Set();
for (const entry of suiteConfig().packages) {
  const artifact = candidate.artifacts[entry.id];
  assert.equal(artifact.name, entry.name);
  suiteVersions.add(artifact.version);
  if (candidate.projection) assert.equal(artifact.version, candidate.projection.version);
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
    for (const privatePackage of ["@pi-suite/companion-contracts", "@pi-suite/host-runtime"]) {
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
            /(?:from\s*|import\s*\()\s*["']@pi-suite\/companion-contracts/,
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
assert.equal(suiteVersions.size, 1, "candidate archives diverge from the Suite version");
process.stdout.write(`Verified ${suiteConfig().packages.length} immutable candidate archives.\n`);
