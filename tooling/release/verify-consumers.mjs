import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { root, run, runAsync, suiteConfig } from "./lib.mjs"

run("node", ["tooling/release/verify-candidates.mjs"])

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"))
assert.equal(candidate.releasable, true, "consumer verification requires a releasable candidate")

const packages = suiteConfig().packages.map((entry) => {
  const artifact = candidate.artifacts[entry.id]
  assert.ok(artifact, `candidate is missing ${entry.id}`)
  return {
    ...entry,
    version: artifact.version,
    archive: resolve(root, "release/candidates", artifact.archive),
  }
})

await Promise.all(
  packages
    .filter(({ id }) => id !== "web")
    .map((entry) =>
      runAsync("pnpm", ["--filter", entry.name, "run", "release:archive-check", "--", entry.archive]),
    ),
)

const web = packages.find(({ id }) => id === "web")
assert.ok(web)
run("node", [
  "apps/web/scripts/test-package.mjs",
  "--consumer",
  "npm",
  "--checks",
  "structure,install,bin,cli,health,page,browser,sse,cleanup,port-release",
  web.archive,
])

const verifyCombinedInstall = async (consumer) => {
  const directory = mkdtempSync(join(tmpdir(), `pi-suite-${consumer}-consumer-`))
  try {
    if (consumer === "npm") {
      await runAsync("npm", ["init", "-y"], { cwd: directory })
      await runAsync("npm", ["install", ...packages.map(({ archive }) => archive)], { cwd: directory })
    } else {
      writeFileSync(join(directory, "package.json"), '{"private":true}\n')
      writeFileSync(
        join(directory, "pnpm-workspace.yaml"),
        'allowBuilds:\n  "@google/genai": false\n  msgpackr-extract: false\n  protobufjs: false\n',
      )
      await runAsync("pnpm", ["add", ...packages.map(({ archive }) => archive)], { cwd: directory })
    }
    for (const entry of packages) {
      const manifest = JSON.parse(
        readFileSync(join(directory, "node_modules", ...entry.name.split("/"), "package.json"), "utf8"),
      )
      assert.equal(manifest.version, entry.version, `${consumer} installed the wrong ${entry.name}`)
    }
    assert.equal(
      (() => {
        try {
          readFileSync(join(directory, "node_modules", "@pi-suite", "companion-contracts", "package.json"))
          return true
        } catch {
          return false
        }
      })(),
      false,
      `${consumer} installed the private contracts package`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

await Promise.all([verifyCombinedInstall("npm"), verifyCombinedInstall("pnpm")])
process.stdout.write("Verified raw Pi loading, pi-web runtime, and combined npm/pnpm consumers.\n")
