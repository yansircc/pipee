import { run } from "./lib.mjs";

const [phase, releaseSha] = process.argv.slice(2);

const buildCandidate = (release) => {
  run("node", ["tooling/release/build-candidates.mjs", "--release-sha", release]);
};

const verifyCandidate = () => {
  run("pnpm", ["verify:candidates"]);
};

switch (phase) {
  case "build":
    buildCandidate(releaseSha);
    break;
  case "verify-candidate":
    verifyCandidate();
    break;
  default:
    throw new Error(`unknown candidate pipeline phase: ${String(phase)}`);
}
