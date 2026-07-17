import assert from "node:assert/strict";
import { run } from "./lib.mjs";

const [phase, sourceSha] = process.argv.slice(2);

const prepareSource = (source) => {
  assert.match(source ?? "", /^[0-9a-f]{40}$/, "source preparation requires one source SHA");
  run("node", ["tooling/release/prepare.mjs", source]);
};

const verifyLocalSource = (source) => {
  prepareSource(source);
  run("pnpm", ["verify"]);
};

const verifyReleaseSource = (source) => {
  prepareSource(source);
  run("pnpm", ["release:verify-source"]);
};

const buildCandidate = (source) => {
  const args = ["tooling/release/build-candidates.mjs"];
  if (source !== undefined) args.push("--prepared-source", source);
  run("node", args);
};

const verifyCandidate = () => {
  run("pnpm", ["verify:candidates"]);
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
    verifyLocalSource(sourceSha);
    buildCandidate(sourceSha);
    verifyCandidate();
    break;
  default:
    throw new Error(`unknown candidate pipeline phase: ${String(phase)}`);
}
