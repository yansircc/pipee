import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../../", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(resolve(root, "apps/pipee/package.json"), "utf8"));
const coordinate = `${manifest.name}@${manifest.version}`;
const registry = "https://registry.npmjs.org";
const published = execFileSync("npm", ["view", coordinate, "version", `--registry=${registry}`], {
  encoding: "utf8",
}).trim();
assert.equal(published, manifest.version, `${coordinate} is not publicly visible`);

const consumer = mkdtempSync(join(tmpdir(), "pipee-site-public-package-"));
try {
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `--registry=${registry}`,
      coordinate,
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const installed = JSON.parse(
    readFileSync(resolve(consumer, "node_modules", "@yansircc", "pipee", "package.json"), "utf8"),
  );
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

process.stdout.write(`Verified fresh public install of ${coordinate}.\n`);
