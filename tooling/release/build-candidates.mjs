import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { create, extract } from "tar"
import { root, run, sha512Integrity, suiteConfig } from "./lib.mjs"

const development = process.argv.includes("--development")
const candidateDirectory = resolve(root, "release/candidates")
const candidateManifestPath = resolve(root, "release/candidate.json")
let sourceSha = null
try {
  sourceSha = run("git", ["rev-parse", "--verify", "-q", "HEAD"], { capture: true }).trim()
} catch (error) {
  if (!development) throw error
}
const dirty = run("git", ["status", "--porcelain"], { capture: true }).trim().length > 0
if ((!sourceSha || dirty) && !development) {
  throw new Error("release candidates require a clean committed worktree")
}

rmSync(candidateDirectory, { recursive: true, force: true })
mkdirSync(candidateDirectory, { recursive: true })

const artifacts = {}
for (const entry of suiteConfig().packages) {
  const packageDirectory = resolve(root, entry.path)
  if (entry.prepareScript) run("pnpm", ["run", entry.prepareScript], { cwd: packageDirectory })
  const before = new Set(readdirSync(candidateDirectory))
  run("pnpm", ["pack", "--pack-destination", candidateDirectory], {
    cwd: packageDirectory,
  })
  const created = readdirSync(candidateDirectory).filter((file) => !before.has(file) && file.endsWith(".tgz"))
  assert.equal(created.length, 1, `${entry.id} must emit one archive`)
  const archive = join(candidateDirectory, created[0])
  const stagingDirectory = mkdtempSync(join(tmpdir(), "pi-suite-candidate-"))
  try {
    await extract({ file: archive, cwd: stagingDirectory })
    const packedManifestPath = join(stagingDirectory, "package", "package.json")
    const packedManifest = JSON.parse(readFileSync(packedManifestPath, "utf8"))
    if (packedManifest.devDependencies) {
      delete packedManifest.devDependencies["@pi-suite/companion-contracts"]
      if (Object.keys(packedManifest.devDependencies).length === 0) {
        delete packedManifest.devDependencies
      }
    }
    writeFileSync(packedManifestPath, `${JSON.stringify(packedManifest, null, 2)}\n`)
    rmSync(archive)
    await create(
      { file: archive, cwd: stagingDirectory, gzip: true, portable: true, noMtime: true },
      ["package"],
    )
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
  const packageManifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"))
  artifacts[entry.id] = {
    name: entry.name,
    version: packageManifest.version,
    archive: basename(archive),
    integrity: sha512Integrity(readFileSync(archive)),
    ...(entry.browserExtension
      ? {
          browserExtensionVersion: JSON.parse(
            readFileSync(resolve(packageDirectory, entry.browserExtension), "utf8"),
          ).version,
          protocolCompatibilityVerifiedBy: "@yansircc/pi-chrome release:archive-check",
        }
      : {}),
  }
}

writeFileSync(
  candidateManifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceSha,
      dirty,
      releasable: sourceSha !== null && !dirty,
      artifacts,
    },
    null,
    2,
  )}\n`,
)
process.stdout.write(`${development && dirty ? "Development" : "Release"} candidate written to release/candidate.json\n`)
