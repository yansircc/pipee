import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { root, readJson, suiteConfig } from "./lib.mjs"

const config = suiteConfig()
const current = readJson("release/current.json")
const rootManifest = readJson("package.json")
assert.equal(config.schemaVersion, 1)
assert.equal(current.schemaVersion, 1)
assert.equal(rootManifest.devDependencies?.typescript, "catalog:", "root TypeScript must use the catalog")
assert.equal(
  rootManifest.devDependencies?.["@effect/tsgo"],
  "catalog:",
  "root Effect diagnostics must use the catalog",
)
assert.equal(
  rootManifest.scripts?.prepare,
  "effect-tsgo patch --typescript-package typescript",
  "the workspace root must own the Effect TypeScript patch",
)

const names = new Set()
for (const entry of config.packages) {
  const directory = resolve(root, entry.path)
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  assert.equal(manifest.name, entry.name, `${entry.id} package name drifted`)
  assert.equal(current.packages[entry.id]?.name, entry.name, `${entry.id} release name drifted`)
  assert.equal(current.packages[entry.id]?.version, manifest.version, `${entry.id} release version drifted`)
  assert.equal(names.has(entry.name), false, `duplicate package ${entry.name}`)
  names.add(entry.name)
  assert.equal(existsSync(join(directory, "pnpm-lock.yaml")), false, `${entry.id} owns a nested lockfile`)
  assert.equal(existsSync(join(directory, "pnpm-workspace.yaml")), false, `${entry.id} owns nested workspace config`)
  for (const fixture of entry.upgradeFixtures) {
    assert.equal(existsSync(resolve(root, fixture)), true, `${entry.id} is missing ${fixture}`)
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  for (const dependency of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@effect/platform-browser",
    "@effect/platform-node",
    "@effect/tsgo",
    "@effect/vitest",
    "@yansircc/effect-scan",
    "effect",
    "typescript",
    "vite",
    "vite-plus",
    "vitest",
  ]) {
    if (dependency in dependencies) {
      assert.equal(dependencies[dependency], "catalog:", `${entry.id} bypasses catalog for ${dependency}`)
    }
  }
  assert.equal(
    manifest.devDependencies?.["@pi-suite/companion-contracts"],
    "workspace:*",
    `${entry.id} must compile against the shared contracts`,
  )
  assert.equal(manifest.scripts?.prepare, undefined, `${entry.id} duplicates the root prepare hook`)
  assert.equal(manifest.scripts?.prepack, undefined, `${entry.id} rebuilds during candidate packing`)
  assert.equal(
    manifest.devDependencies?.["@effect/tsgo"],
    undefined,
    `${entry.id} duplicates the root Effect diagnostics owner`,
  )
  assert.equal(
    manifest.devDependencies?.typescript,
    undefined,
    `${entry.id} duplicates the root TypeScript owner`,
  )
}

const schemaOwners = [
  ["pi-chrome/status", "protocols/companion-contracts/src/chrome.ts"],
  ["pi-weixin/status", "protocols/companion-contracts/src/weixin.ts"],
  ["pi-loop/status", "protocols/companion-contracts/src/loop.ts"],
]
const sourceFiles = []
const pending = [resolve(root, "apps/web/src"), resolve(root, "extensions"), resolve(root, "protocols")]
while (pending.length > 0) {
  const directory = pending.pop()
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) pending.push(path)
    else if (/\.(?:ts|tsx)$/.test(item.name)) sourceFiles.push(path)
  }
}
for (const [literal, owner] of schemaOwners) {
  const declarations = sourceFiles.filter((path) =>
    readFileSync(path, "utf8").includes(`Schema.Literal("${literal}")`),
  )
  assert.deepEqual(
    declarations.map((path) => relative(root, path)),
    [owner],
    `${literal} must have one Schema owner`,
  )
}

assert.equal(statSync(resolve(root, "pnpm-lock.yaml")).isFile(), true, "root lockfile is missing")
process.stdout.write(`Verified ${config.packages.length} Suite packages and ${schemaOwners.length} shared contracts.\n`)
