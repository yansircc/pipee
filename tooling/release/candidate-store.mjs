import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { create, extract } from "tar";
import { root, sha512Integrity, suiteConfig } from "./lib.mjs";

const sourcePattern = /^[0-9a-f]{40}$/;

export const candidateAssetName = (sourceSha) => {
  assert.match(sourceSha, sourcePattern, "candidate source must be a full commit SHA");
  return `suite-candidates-${sourceSha}.tgz`;
};

const assertPlainTree = (directory) => {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `candidate store contains a symlink: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else assert.equal(stat.isFile(), true, `candidate store contains a non-file: ${path}`);
    }
  }
};

export const verifyStoredCandidate = (candidateRoot, expectedSource) => {
  assert.match(expectedSource, sourcePattern, "expected source must be a full commit SHA");
  const manifestPath = resolve(candidateRoot, "candidate.json");
  assert.equal(existsSync(manifestPath), true, "stored candidate manifest is missing");
  const candidate = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(candidate.schemaVersion, 3, "stored candidate schema is unsupported");
  assert.equal(candidate.sourceSha, expectedSource, "stored candidate belongs to another source");
  assert.equal(candidate.releasable, true, "stored candidate is not releasable");
  assert.ok(candidate.projection, "stored candidate has no Suite version projection");

  const expectedIds = suiteConfig().packages.map(({ id }) => id).sort();
  assert.deepEqual(Object.keys(candidate.artifacts).sort(), expectedIds, "stored candidate package set drifted");
  for (const entry of suiteConfig().packages) {
    const artifact = candidate.artifacts[entry.id];
    assert.equal(artifact.name, entry.name, `${entry.id} package name drifted`);
    assert.equal(artifact.version, candidate.projection.version, `${entry.id} version drifted`);
    assert.equal(basename(artifact.archive), artifact.archive, `${entry.id} archive name is not flat`);
    const archive = resolve(candidateRoot, "candidates", artifact.archive);
    assert.equal(existsSync(archive), true, `${entry.id} archive is missing`);
    assert.equal(
      sha512Integrity(readFileSync(archive)),
      artifact.integrity,
      `${entry.id} archive integrity drifted`,
    );
  }
  assertPlainTree(candidateRoot);
  return candidate;
};

export const bundleCandidate = async ({ candidateRoot, assetDirectory, expectedSource }) => {
  verifyStoredCandidate(candidateRoot, expectedSource);
  mkdirSync(assetDirectory, { recursive: true });
  const asset = resolve(assetDirectory, candidateAssetName(expectedSource));
  rmSync(asset, { force: true });
  await create(
    {
      cwd: candidateRoot,
      file: asset,
      gzip: true,
      portable: true,
      noMtime: true,
    },
    ["candidate.json", "candidates"],
  );
  return asset;
};

export const restoreCandidate = async ({ asset, candidateRoot, expectedSource }) => {
  assert.equal(basename(asset), candidateAssetName(expectedSource), "candidate asset name drifted");
  const staging = mkdtempSync(join(tmpdir(), "pi-suite-candidate-store-"));
  try {
    await extract({
      cwd: staging,
      file: asset,
      strict: true,
      filter: (path) => {
        assert.ok(
          path === "candidate.json" || path === "candidates" || path.startsWith("candidates/"),
          `candidate asset contains an unexpected entry: ${path}`,
        );
        return true;
      },
    });
    verifyStoredCandidate(staging, expectedSource);
    mkdirSync(candidateRoot, { recursive: true });
    const stagedCandidate = resolve(candidateRoot, ".candidate.json.next");
    const stagedArchives = resolve(candidateRoot, ".candidates.next");
    rmSync(stagedCandidate, { force: true });
    rmSync(stagedArchives, { recursive: true, force: true });
    cpSync(resolve(staging, "candidate.json"), stagedCandidate);
    cpSync(resolve(staging, "candidates"), stagedArchives, { recursive: true });
    rmSync(resolve(candidateRoot, "candidate.json"), { force: true });
    rmSync(resolve(candidateRoot, "candidates"), { recursive: true, force: true });
    renameSync(stagedCandidate, resolve(candidateRoot, "candidate.json"));
    renameSync(stagedArchives, resolve(candidateRoot, "candidates"));
    return verifyStoredCandidate(candidateRoot, expectedSource);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

const [, , command, sourceSha, input] = process.argv;
if (command === "bundle") {
  const asset = await bundleCandidate({
    candidateRoot: resolve(root, "release"),
    assetDirectory: resolve(root, "release/assets"),
    expectedSource: sourceSha,
  });
  process.stdout.write(`${asset}\n`);
} else if (command === "restore") {
  if (!input) throw new Error("usage: candidate-store.mjs restore <source-sha> <asset>");
  await restoreCandidate({
    asset: resolve(input),
    candidateRoot: resolve(root, "release"),
    expectedSource: sourceSha,
  });
  process.stdout.write(`Restored exact candidate for ${sourceSha}.\n`);
} else if (process.argv[1]?.endsWith("candidate-store.mjs")) {
  throw new Error("usage: candidate-store.mjs bundle <source-sha> | restore <source-sha> <asset>");
}
