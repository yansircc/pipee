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
  for (const entry of suiteConfig().packages) {
    const archive = `${entry.id}-0.6.0.tgz`;
    const bytes = Buffer.from(`first witnessed bytes for ${entry.id}`);
    writeFileSync(join(archives, archive), bytes);
    artifacts[entry.id] = {
      name: entry.name,
      version: "0.6.0",
      archive,
      integrity: sha512Integrity(bytes),
    };
  }
  writeFileSync(
    join(directory, "candidate.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      sourceSha: source,
      releasable: true,
      projection: { kind: "suite-version", files: [], version: "0.6.0" },
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
