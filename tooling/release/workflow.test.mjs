import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { resolve } from "node:path";
import { root, run } from "./lib.mjs";

const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const containerPreflight = readFileSync(
  resolve(root, "tooling/release/container-preflight.mjs"),
  "utf8",
);
const candidatePipeline = readFileSync(
  resolve(root, "tooling/release/candidate-pipeline.mjs"),
  "utf8",
);
const releaseLib = readFileSync(resolve(root, "tooling/release/lib.mjs"), "utf8");
const classifier = readFileSync(resolve(root, "tooling/release/classify.mjs"), "utf8");
const webConfig = readFileSync(resolve(root, "apps/web/vite.config.ts"), "utf8");
const consumerVerifier = readFileSync(
  resolve(root, "tooling/release/verify-consumers.mjs"),
  "utf8",
);
const candidateBuilder = readFileSync(
  resolve(root, "tooling/release/build-candidates.mjs"),
  "utf8",
);
const publisher = readFileSync(resolve(root, "tooling/release/publish-candidates.mjs"), "utf8");

it("publishes only the explicit independent package release set", () => {
  assert.match(workflow, /source_release: \$\{\{ steps\.commit\.outputs\.source_release \}\}/);
  assert.match(
    workflow,
    /if: needs\.classify\.outputs\.release_commit == 'false' && needs\.classify\.outputs\.source_release == 'true'/,
  );
  assert.match(
    candidateBuilder,
    /const selectedEntries = preparedSource \? plan\.packages : suiteConfig\(\)\.packages/,
  );
  assert.doesNotMatch(candidateBuilder, /share one Suite version|versions\.every/);
  assert.match(publisher, /flatMap\(\(entry\)/);
  assert.doesNotMatch(publisher, /candidate is missing/);
  assert.match(workflow, /create-release-record\.mjs/);
  assert.match(workflow, /projection\.packages\.map\(p=>p\.tag\)/);
});

it("reports an ordinary nonzero child exit without dereferencing a null spawn error", () => {
  assert.throws(
    () => run(process.execPath, ["-e", "process.exit(7)"], { capture: true }),
    /failed with exit 7/,
  );
});

it("owns one Linux candidate and same-artifact macOS/Windows witnesses", () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /candidate:[\s\S]*runs-on: ubuntu-latest/);
  assert.match(workflow, /matrix:[\s\S]*os: \[macos-14, windows-2022\]/);
  assert.match(workflow, /platform-witness:[\s\S]*download-artifact/);
  assert.doesNotMatch(
    workflow.match(/platform-witness:[\s\S]*?\n  publish:/)?.[0] ?? "",
    /build-candidates|\bpack\b/,
  );
  assert.match(workflow, /suite-candidates-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.match(workflow, /artifact: \$\{\{ steps\.artifact\.outputs\.name \}\}/);
  assert.match(workflow, /name: \$\{\{ needs\.candidate\.outputs\.artifact \}\}/);
  assert.match(workflow, /group: \$\{\{ github\.event_name == 'push'[\s\S]*pi-suite-release-pr-/);
  assert.match(workflow, /queue: max/);
});

it("restores an existing source and persists its exact candidate before npm publication", () => {
  const materialize =
    workflow.match(
      /name: Materialize the one candidate[\s\S]*?\n      - run: node tooling\/release\/candidate-pipeline\.mjs verify-candidate/,
    )?.[0] ?? "";
  const publish = workflow.match(/\n  publish:[\s\S]*?\n  public-acceptance:/)?.[0] ?? "";
  const existing = materialize.match(/else\n[\s\S]*?candidate-store\.mjs restore/)?.[0] ?? "";
  assert.match(existing, /gh release download/);
  assert.match(materialize, /gh run download/);
  assert.doesNotMatch(existing, /build-candidates|\bpack\b/);
  assert.match(publish, /Persist the exact candidate before publication[\s\S]*gh release upload/);
  assert.ok(
    publish.indexOf("Persist the exact candidate before publication") <
      publish.indexOf("pnpm publish:candidates"),
    "durable candidate must exist before the first npm publish",
  );
  assert.doesNotMatch(workflow, /--existing-release/);
  assert.doesNotMatch(workflow, /overwrite:\s*true|--clobber/);
});

it("reuses a prior attempt candidate even before a release record exists", () => {
  const materialize =
    workflow.match(
      /name: Materialize the one candidate[\s\S]*?\n      - run: node tooling\/release\/candidate-pipeline\.mjs verify-candidate/,
    )?.[0] ?? "";
  assert.match(materialize, /actions\/runs\/\$GITHUB_RUN_ID\/artifacts/);
  assert.match(materialize, /elif \[ -n "\$prior_artifact" \]; then\s+restore_prior_attempt/);
  const restoreIndex = materialize.indexOf('elif [ -n "$prior_artifact" ]');
  const buildIndex = materialize.indexOf('candidate-pipeline.mjs build "${{ github.sha }}"');
  assert.ok(
    restoreIndex >= 0 && restoreIndex < buildIndex,
    "full rerun must restore before considering a rebuild",
  );
});

it("shares one candidate pipeline between clean Linux preflight and Actions", () => {
  const candidate = workflow.match(/\n  candidate:[\s\S]*?\n  platform-witness:/)?.[0] ?? "";
  assert.match(candidate, /candidate-pipeline\.mjs verify-release-source/);
  assert.match(candidate, /candidate-pipeline\.mjs build/);
  assert.match(candidate, /candidate-pipeline\.mjs verify-candidate/);
  assert.doesNotMatch(candidate, /steps\.prepare/);
  assert.doesNotMatch(candidate, /- run: pnpm verify(?:\s|$)/);
  assert.doesNotMatch(candidate, /release:check/);
  assert.doesNotMatch(candidate, /node tooling\/release\/build-candidates\.mjs/);
  assert.match(containerPreflight, /git status.*--porcelain/);
  assert.match(containerPreflight, /@yansircc\/pi-chrome.*release:check/);
  assert.match(containerPreflight, /\["bundle", "create", bundlePath, "HEAD"\]/);
  assert.match(containerPreflight, /target=\/input,readonly/);
  assert.doesNotMatch(containerPreflight, /target=\/source,readonly/);
  assert.match(containerPreflight, /pnpm fetch --frozen-lockfile/);
  assert.match(containerPreflight, /pnpm install --offline --frozen-lockfile/);
  assert.match(containerPreflight, /preflight-image/);
  assert.match(containerPreflight, /candidate-pipeline\.mjs full/);
});

it("keeps full consumer verification in local preflight and out of the release narrow gate", () => {
  const verifyCandidate =
    candidatePipeline.match(/const verifyCandidate = \(\) => \{[\s\S]*?\n\};/)?.[0] ?? "";
  const full = candidatePipeline.match(/case "full":[\s\S]*?\n    break;/)?.[0] ?? "";
  assert.match(verifyCandidate, /\["verify:candidates"\]/);
  assert.doesNotMatch(verifyCandidate, /verify:consumers/);
  assert.match(full, /verifyCandidate\(\);\s+verifyConsumers\(\);/);
  assert.doesNotMatch(workflow, /verify:consumers/);
});

it("resolves package binaries through the shared cross-platform process boundary", () => {
  assert.match(releaseLib, /import crossSpawn from "cross-spawn"/);
  assert.match(releaseLib, /crossSpawn\.sync\(command, args/);
  assert.doesNotMatch(releaseLib, /spawnSync\(command, args/);
});

it("keeps source classification install-free", () => {
  const classifyJob = workflow.match(/\n  classify:[\s\S]*?\n  candidate:/)?.[0] ?? "";
  assert.doesNotMatch(classifier, /from "\.\/lib\.mjs"|from "cross-spawn"/);
  assert.match(classifier, /execFileSync\("git", args/);
  assert.doesNotMatch(classifyJob, /pnpm install|setup-node|pnpm\/action-setup/);
});

it("keeps source quality distinct from the one production candidate", () => {
  const verifyTask = webConfig.match(/"ci:verify": \{[\s\S]*?\n      \},/)?.[0] ?? "";
  assert.match(verifyTask, /pnpm test:e2e:run/);
  assert.doesNotMatch(verifyTask, /pnpm build|pnpm test:package/);
});

it("parallelizes only independent candidate consumers", () => {
  assert.match(consumerVerifier, /await Promise\.all\([\s\S]*?release:archive-check/);
  assert.match(consumerVerifier, /run\("node", \[[\s\S]*?apps\/web\/scripts\/test-package\.mjs/);
  assert.match(
    consumerVerifier,
    /Promise\.all\(\[verifyCombinedInstall\("npm"\), verifyCombinedInstall\("pnpm"\)\]\)/,
  );
});

it("keeps OIDC publish and public propagation in separate jobs", () => {
  const publish = workflow.match(/\n  publish:[\s\S]*?\n  public-acceptance:/)?.[0] ?? "";
  const publicAcceptance = workflow.match(/\n  public-acceptance:[\s\S]*$/)?.[0] ?? "";
  assert.match(publish, /id-token: write/);
  assert.match(publish, /npm 11\.5\.1 or newer/);
  assert.match(publish, /pnpm publish:candidates/);
  assert.doesNotMatch(publish, /verify:registry/);
  assert.match(publicAcceptance, /needs: \[candidate, publish\]/);
  assert.match(publicAcceptance, /pnpm verify:registry/);
  assert.doesNotMatch(publicAcceptance, /publish:candidates/);
  assert.doesNotMatch(workflow, /registry-url:/);
});
