import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { root, readJson, suiteConfig } from "./lib.mjs";

const config = suiteConfig();
const rootManifest = readJson("package.json");
assert.equal(config.schemaVersion, 1);
assert.match(rootManifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
assert.equal(
  rootManifest.devDependencies?.typescript,
  "catalog:",
  "root TypeScript must use the catalog",
);
assert.equal(
  rootManifest.devDependencies?.["@effect/tsgo"],
  "catalog:",
  "root Effect diagnostics must use the catalog",
);
assert.equal(
  rootManifest.scripts?.prepare,
  "effect-tsgo patch --typescript-package typescript",
  "the workspace root must own the Effect TypeScript patch",
);

const names = new Set();
const suiteRepository = "git+https://github.com/yansircc/pi-suite.git";
const suiteIssues = "https://github.com/yansircc/pi-suite/issues";
for (const entry of config.packages) {
  const directory = resolve(root, entry.path);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, entry.name, `${entry.id} package name drifted`);
  assert.equal(
    manifest.version,
    rootManifest.version,
    `${entry.id} diverges from the Suite version`,
  );
  assert.equal(names.has(entry.name), false, `duplicate package ${entry.name}`);
  names.add(entry.name);
  assert.deepEqual(
    manifest.repository,
    { type: "git", url: suiteRepository, directory: entry.path },
    `${entry.id} package metadata does not point at its Suite directory`,
  );
  assert.equal(manifest.bugs?.url, suiteIssues, `${entry.id} package bugs URL drifted`);
  assert.equal(
    manifest.homepage,
    `https://github.com/yansircc/pi-suite/tree/main/${entry.path}#readme`,
    `${entry.id} package homepage drifted`,
  );
  assert.equal(
    existsSync(join(directory, "pnpm-lock.yaml")),
    false,
    `${entry.id} owns a nested lockfile`,
  );
  assert.equal(
    existsSync(join(directory, "pnpm-workspace.yaml")),
    false,
    `${entry.id} owns nested workspace config`,
  );
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dependency of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@effect/platform-browser",
    "@effect/platform-node",
    "@effect/tsgo",
    "@effect/vitest",
    "@types/cross-spawn",
    "@yansircc/effect-scan",
    "effect",
    "jiti",
    "typescript",
    "vite",
    "vite-plus",
    "vitest",
  ]) {
    if (dependency in dependencies) {
      assert.equal(
        dependencies[dependency],
        "catalog:",
        `${entry.id} bypasses catalog for ${dependency}`,
      );
    }
  }
  assert.equal(
    manifest.devDependencies?.["@pi-suite/companion-contracts"],
    "workspace:*",
    `${entry.id} must compile against the shared contracts`,
  );
  assert.equal(
    manifest.scripts?.prepare,
    undefined,
    `${entry.id} duplicates the root prepare hook`,
  );
  assert.equal(
    manifest.scripts?.prepack,
    undefined,
    `${entry.id} rebuilds during candidate packing`,
  );
  assert.equal(
    typeof entry.platformChecks?.default,
    "string",
    `${entry.id} must declare a default exact-candidate platform witness`,
  );
  for (const script of new Set(Object.values(entry.platformChecks ?? {}))) {
    assert.equal(
      typeof manifest.scripts?.[script],
      "string",
      `${entry.id} is missing platform script ${script}`,
    );
    assert.doesNotMatch(
      manifest.scripts[script],
      /\b(?:build|pack|pi:build|pi:domain-check)\b/,
      `${entry.id} platform witness ${script} rebuilds candidate facts`,
    );
  }
  assert.equal(
    manifest.devDependencies?.["@effect/tsgo"],
    undefined,
    `${entry.id} duplicates the root Effect diagnostics owner`,
  );
  assert.equal(
    manifest.devDependencies?.typescript,
    undefined,
    `${entry.id} duplicates the root TypeScript owner`,
  );
}

const schemaOwners = [
  ["pi-chrome/status", "protocols/companion-contracts/src/chrome.ts"],
  ["pi-weixin/status", "protocols/companion-contracts/src/weixin.ts"],
  ["pi-loop/status", "protocols/companion-contracts/src/loop.ts"],
];

for (const entry of config.packages.filter(({ id }) => id !== "web")) {
  const directory = resolve(root, entry.path);
  assert.equal(
    existsSync(join(directory, "scripts/pi-extension/config.mjs")),
    true,
    `${entry.id} is missing its distribution config`,
  );
  for (const file of ["build.mjs", "distribution-contract.mjs", "verify-distribution.mjs"]) {
    assert.equal(
      existsSync(join(directory, "scripts/pi-extension", file)),
      false,
      `${entry.id} duplicates root Pi extension tooling: ${file}`,
    );
  }
}
for (const entry of config.packages) {
  assert.equal(
    existsSync(resolve(root, entry.path, "scripts/release")),
    false,
    `${entry.id} retains a leaf release owner`,
  );
}
for (const file of ["build.mjs", "distribution-contract.mjs", "verify-distribution.mjs"]) {
  assert.equal(
    existsSync(resolve(root, "tooling/pi-extension", file)),
    true,
    `root tooling is missing ${file}`,
  );
}
const sourceFiles = [];
const pending = [
  resolve(root, "apps/web/src"),
  resolve(root, "extensions"),
  resolve(root, "protocols"),
];
while (pending.length > 0) {
  const directory = pending.pop();
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) pending.push(path);
    else if (/\.(?:ts|tsx)$/.test(item.name)) sourceFiles.push(path);
  }
}
for (const [literal, owner] of schemaOwners) {
  const declarations = sourceFiles.filter((path) =>
    readFileSync(path, "utf8").includes(`Schema.Literal("${literal}")`),
  );
  assert.deepEqual(
    declarations.map((path) => relative(root, path)),
    [owner],
    `${literal} must have one Schema owner`,
  );
}

assert.equal(statSync(resolve(root, "pnpm-lock.yaml")).isFile(), true, "root lockfile is missing");
const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
for (const forbidden of [
  ["NPM", "TOKEN"].join("_"),
  ["NODE", "AUTH", "TOKEN"].join("_"),
  ["_auth", "Token"].join(""),
]) {
  assert.equal(
    releaseWorkflow.includes(forbidden),
    false,
    `release workflow contains token fallback ${forbidden}`,
  );
}
process.stdout.write(
  `Verified ${config.packages.length} Suite packages and ${schemaOwners.length} shared contracts.\n`,
);
