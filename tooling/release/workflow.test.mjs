import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { it } from "node:test";
import { resolve } from "node:path";
import { root, run } from "./lib.mjs";

const candidate = readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8");
const promotion = readFileSync(resolve(root, ".github/workflows/release-promote.yml"), "utf8");
const promoter = readFileSync(resolve(root, "tooling/release/promote-candidate.mjs"), "utf8");
const submitter = readFileSync(resolve(root, "tooling/release/submit-release-candidate.mjs"), "utf8");
const materializer = readFileSync(
  resolve(root, "tooling/release/materialize-release-candidate.mjs"),
  "utf8",
);

it("runs candidate code only in a manually dispatched read-only witness workflow", () => {
  assert.match(candidate, /workflow_dispatch:/);
  assert.doesNotMatch(candidate, /push:|pull_request:/);
  assert.match(candidate, /permissions:\s+contents: read/);
  assert.doesNotMatch(candidate, /contents: write|id-token: write/);
  assert.match(candidate, /persist-credentials: false/);
  assert.match(candidate, /ref: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(candidate, /node tooling\/release\/classify\.mjs/);
});

it("owns one Linux archive set and fans out exact witnesses", () => {
  assert.equal((candidate.match(/candidate-pipeline\.mjs build/g) ?? []).length, 1);
  assert.match(candidate, /- run: pnpm verify\s/);
  assert.match(candidate, /- run: pnpm verify:candidates/);
  assert.match(
    candidate,
    /pnpm exec playwright install --with-deps chromium[\s\S]*pnpm verify:consumers/,
  );
  assert.match(candidate, /- run: pnpm verify:consumers/);
  assert.match(candidate, /pnpm --filter @yansircc\/pi-chrome run release:check/);
  assert.match(candidate, /- run: pnpm verify:chrome-candidate/);
  assert.match(candidate, /matrix:[\s\S]*os: \[macos-14, windows-2022\]/);
  assert.match(candidate, /actions\/download-artifact@v7/);
  assert.match(candidate, /retention-days: 14/);
  assert.doesNotMatch(
    candidate.match(/platform-witness:[\s\S]*?\n  witness:/)?.[0] ?? "",
    /build-candidates|candidate-pipeline\.mjs build|\bpack\b/,
  );
});

it("keeps promotion privileged, trusted, and free of candidate execution", () => {
  assert.match(promotion, /workflow_run:[\s\S]*workflows: \[Release Candidate\]/);
  const privileged = promotion.match(/promote-and-publish:[\s\S]*?\n  public-acceptance:/)?.[0] ?? "";
  assert.match(privileged, /contents: write/);
  assert.match(privileged, /id-token: write/);
  assert.match(privileged, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.doesNotMatch(privileged, /pnpm install|npm install|ref: \$\{\{ steps\.artifact\.outputs\.release_sha \}\}/);
  assert.match(privileged, /promote-candidate\.mjs verify/);
  assert.match(privileged, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(privileged, /promote-candidate\.mjs promote/);
  assert.match(privileged, /promote-candidate\.mjs persist/);
  assert.match(privileged, /promote-candidate\.mjs publish/);
  assert.match(promoter, /--ignore-scripts/);
  assert.match(promoter, /git", \["push", "--atomic"/);
  assert.doesNotMatch(promoter, /import .*\.\/lib\.mjs|cross-spawn/);
  assert.match(promoter, /"pack", archive, "--dry-run", "--json", "--ignore-scripts"/);
});

it("keeps public propagation separate from irreversible publication", () => {
  const publicAcceptance = promotion.match(/public-acceptance:[\s\S]*$/)?.[0] ?? "";
  assert.match(publicAcceptance, /pnpm verify:registry/);
  assert.doesNotMatch(publicAcceptance, /id-token: write|contents: write|npm publish/);
});

it("has one release entry and no compatibility release path", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["release:submit"], "node tooling/release/submit-release-candidate.mjs");
  for (const script of ["push:release", "release:preflight", "publish:candidates"]) {
    assert.equal(manifest.scripts[script], undefined);
  }
  for (const file of [
    ".github/workflows/release.yml",
    "tooling/release/push-release.mjs",
    "tooling/release/container-preflight.mjs",
    "tooling/release/prepare.mjs",
    "tooling/release/create-release-record.mjs",
    "tooling/release/publish-candidates.mjs",
  ]) {
    assert.equal(existsSync(resolve(root, file)), false, `${file} is a forbidden compatibility path`);
  }
  assert.doesNotMatch(candidate + promotion, /queue: max|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
  assert.match(materializer, /"commit-tree"[\s\S]*"-p", base, "-p", source/);
  assert.match(submitter, /typeof output === "string" \? output\.trim\(\) : ""/);
  assert.match(submitter, /git", \["fetch", "origin", "main"\]/);
  assert.match(
    submitter,
    /refs\/remotes\/origin\/main[\s\S]*publish the release control plane before creating an immutable candidate/,
  );
  assert.ok(
    submitter.indexOf('git", ["fetch", "origin", "main"') <
      submitter.indexOf("materialize-release-candidate.mjs"),
  );
});

it("reports an ordinary nonzero child exit without dereferencing a null spawn error", () => {
  assert.throws(
    () => run(process.execPath, ["-e", "process.exit(7)"], { capture: true }),
    /failed with exit 7/,
  );
});
