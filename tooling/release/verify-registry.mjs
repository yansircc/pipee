import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { root, run, suiteConfig } from "./lib.mjs"
import { classifyRegistryLookup, requireRegistryIntegrity } from "./registry-state.mjs"

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"))
assert.equal(candidate.releasable, true, "public acceptance requires a releasable candidate")

const packages = suiteConfig().packages.map((entry) => {
  const artifact = candidate.artifacts[entry.id]
  assert.ok(artifact, `candidate is missing ${entry.id}`)
  const lookup = spawnSync("npm", ["view", `${artifact.name}@${artifact.version}`, "dist.integrity", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  requireRegistryIntegrity(classifyRegistryLookup(lookup), artifact.integrity)
  return { ...entry, version: artifact.version, coordinate: `${artifact.name}@${artifact.version}` }
})

const verifyConsumer = (consumer) => {
  const directory = mkdtempSync(join(tmpdir(), `pi-suite-public-${consumer}-`))
  try {
    writeFileSync(join(directory, "package.json"), '{"private":true}\n')
    if (consumer === "npm") {
      run("npm", ["install", "--ignore-scripts", ...packages.map(({ coordinate }) => coordinate)], { cwd: directory })
    } else {
      writeFileSync(
        join(directory, "pnpm-workspace.yaml"),
        'allowBuilds:\n  "@google/genai": false\n  msgpackr-extract: false\n  protobufjs: false\n',
      )
      run("pnpm", ["add", "--ignore-scripts", ...packages.map(({ coordinate }) => coordinate)], { cwd: directory })
    }

    for (const entry of packages) {
      const installed = JSON.parse(
        readFileSync(join(directory, "node_modules", ...entry.name.split("/"), "package.json"), "utf8"),
      )
      assert.equal(installed.version, entry.version, `${consumer} installed the wrong ${entry.name}`)
    }
    assert.equal(
      existsSync(join(directory, "node_modules", "@pi-suite", "companion-contracts", "package.json")),
      false,
      `${consumer} installed the private contracts package`,
    )
    const bin = process.platform === "win32" ? "pi-web.cmd" : "pi-web"
    assert.equal(existsSync(join(directory, "node_modules", ".bin", bin)), true, `${consumer} is missing pi-web bin`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

verifyConsumer("npm")
verifyConsumer("pnpm")
process.stdout.write("Verified exact registry integrity and fresh npm/pnpm public consumers.\n")
