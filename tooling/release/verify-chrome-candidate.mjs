import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extract } from "tar";
import { root, run } from "./lib.mjs";

run("node", ["tooling/release/verify-candidates.mjs"]);
const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.releasable, true, "Chrome candidate E2E requires a clean exact candidate");
const artifact = candidate.artifacts.chrome;
if (!artifact) {
  process.stdout.write("Chrome is not in this release set; exact-candidate smoke skipped.\n");
  process.exit(0);
}
const temporary = mkdtempSync(join(tmpdir(), "pipee-chrome-candidate-"));
try {
  await extract({
    file: resolve(root, "release", "candidates", artifact.archive),
    cwd: temporary,
  });
  run(
    "node",
    [
      "extensions/chrome/scripts/smoke-connector.ts",
      "--require-browser",
      "--candidate-extension",
      resolve(temporary, "package", "dist", "browser-extension"),
    ],
    { cwd: root },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.stdout.write("Verified the exact pi-chrome candidate in Chrome.\n");
