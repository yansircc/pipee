import assert from "node:assert/strict";
import { run } from "./lib.mjs";

const [phase, sourceSha] = process.argv.slice(2);

const prepareSource = (source) => {
  assert.match(source ?? "", /^[0-9a-f]{40}$/, "source preparation requires one source SHA");
  return JSON.parse(run("node", ["tooling/release/prepare.mjs", source], { capture: true }));
};

const verifyLocalSource = (source) => {
  const plan = prepareSource(source);
  run("pnpm", ["verify"]);
  return plan;
};

const verifyReleaseSource = (source) => {
  const plan = prepareSource(source);
  run("pnpm", ["release:verify-source"]);
  return plan;
};

const buildCandidate = (source) => {
  const args = ["tooling/release/build-candidates.mjs"];
  if (source !== undefined) args.push("--prepared-source", source);
  run("node", args);
};

const verifyCandidate = () => {
  run("pnpm", ["verify:candidates"]);
};

const verifyConsumers = () => {
  run("pnpm", ["verify:consumers"]);
};

switch (phase) {
  case "verify-release-source":
    verifyReleaseSource(sourceSha);
    break;
  case "build":
    buildCandidate(sourceSha);
    break;
  case "verify-candidate":
    assert.equal(sourceSha, undefined, "verify-candidate accepts no source");
    verifyCandidate();
    break;
  case "full":
    assert.match(sourceSha ?? "", /^[0-9a-f]{40}$/, "full preflight requires one source SHA");
    if (verifyLocalSource(sourceSha).mode !== "none") {
      buildCandidate(sourceSha);
      verifyCandidate();
      verifyConsumers();
    }
    break;
  default:
    throw new Error(`unknown candidate pipeline phase: ${String(phase)}`);
}
