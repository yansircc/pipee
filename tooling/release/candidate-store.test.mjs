import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  bundleCandidate,
  candidateAssetName,
  restoreCandidate,
  verifyStoredCandidate,
} from "./candidate-store.mjs";
import { sha512Integrity, suiteConfig } from "./lib.mjs";

const source = "a".repeat(40);

const makeCandidate = (directory) => {
  const archives = join(directory, "candidates");
  mkdirSync(archives, { recursive: true });
  const artifacts = {};
  const selected = suiteConfig().packages.filter(({ id }) => id === "web" || id === "chrome");
  for (const [index, entry] of selected.entries()) {
    const version = index === 0 ? "0.2.0" : "0.1.7";
    const archive = `${entry.id}-${version}.tgz`;
    const bytes = Buffer.from(`first witnessed bytes for ${entry.id}`);
    writeFileSync(join(archives, archive), bytes);
    artifacts[entry.id] = {
      name: entry.name,
      version,
      archive,
      integrity: sha512Integrity(bytes),
    };
  }
  writeFileSync(
    join(directory, "candidate.json"),
    `${JSON.stringify({
      schemaVersion: 4,
      sourceSha: source,
      releasable: true,
      projection: {
        kind: "package-versions",
        releaseTag: `release-${source.slice(0, 12)}`,
        files: selected.map(({ path }) => `${path}/package.json`).sort(),
        changeFiles: [],
        packages: selected.map((entry, index) => ({
          id: entry.id,
          name: entry.name,
          bump: index === 0 ? "minor" : "patch",
          fromVersion: index === 0 ? "0.1.8" : "0.1.6",
          toVersion: index === 0 ? "0.2.0" : "0.1.7",
          tag: `${entry.name.split("/").at(-1)}-v${index === 0 ? "0.2.0" : "0.1.7"}`,
        })),
      },
      artifacts,
    })}\n`,
  );
};

it("restores the exact first candidate instead of rebuilding an existing source", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-suite-candidate-store-test-"));
  try {
    const first = join(fixture, "first");
    const restored = join(fixture, "restored");
    const assets = join(fixture, "assets");
    mkdirSync(first, { recursive: true });
    makeCandidate(first);
    const asset = await bundleCandidate({
      candidateRoot: first,
      assetDirectory: assets,
      expectedSource: source,
    });
    assert.equal(asset.endsWith(candidateAssetName(source)), true);

    await restoreCandidate({ asset, candidateRoot: restored, expectedSource: source });
    const firstCandidate = verifyStoredCandidate(first, source);
    const restoredCandidate = verifyStoredCandidate(restored, source);
    assert.deepEqual(restoredCandidate, firstCandidate);
    for (const artifact of Object.values(firstCandidate.artifacts)) {
      assert.deepEqual(
        readFileSync(join(restored, "candidates", artifact.archive)),
        readFileSync(join(first, "candidates", artifact.archive)),
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it("fails closed for another source or changed archive bytes", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-suite-candidate-store-test-"));
  try {
    const candidate = join(fixture, "candidate");
    mkdirSync(candidate, { recursive: true });
    makeCandidate(candidate);
    assert.throws(() => verifyStoredCandidate(candidate, "b".repeat(40)), /another source/);
    const manifest = verifyStoredCandidate(candidate, source);
    const archive = Object.values(manifest.artifacts)[0].archive;
    writeFileSync(join(candidate, "candidates", archive), "changed bytes");
    assert.throws(() => verifyStoredCandidate(candidate, source), /integrity drifted/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
