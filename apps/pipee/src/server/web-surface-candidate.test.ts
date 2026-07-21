import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeSurfaceId, encodeSurfaceId, readWebSurfaceCandidate } from "./web-surface-candidate"

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipee-surface-"))
  await mkdir(path.join(root, "dist/pi"), { recursive: true })
  await mkdir(path.join(root, "dist/web"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@fixture/surface",
      pi: { extensions: "./dist/pi/extension.js" },
      pipee: { web: { contract: "pipee/web-surface@2", document: "./dist/web/index.html", title: "Fixture" } },
    }),
  )
  await writeFile(path.join(root, "dist/pi/extension.js"), "export default () => {}\n")
  await writeFile(path.join(root, "dist/web/index.html"), "<script type=module src=./app.js></script>")
  await writeFile(path.join(root, "dist/web/app.js"), "export const answer = 42\n")
  return root
}

const addBrowserCompanion = async (root: string) => {
  const packagePath = path.join(root, "package.json")
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    pipee: Record<string, unknown>
  }
  pkg.pipee.browserCompanion = {
    contract: "pipee/browser-companion@2",
    directory: "./dist/browser-extension",
    evidence: "./dist/browser-extension/evidence.json",
  }
  await writeFile(packagePath, JSON.stringify(pkg))
  await mkdir(path.join(root, "dist/browser-extension"), { recursive: true })
  await writeFile(
    path.join(root, "dist/browser-extension/evidence.json"),
    JSON.stringify({
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      displayVersion: "1.2.3",
      protocolFingerprint: "f".repeat(64),
    }),
  )
  await writeFile(path.join(root, "dist/browser-extension/service-worker.js"), "export const candidate = 1\n")
}

describe("web surface candidate", () => {
  it("surface id is canonical base64url", () => {
    const id = encodeSurfaceId("@fixture/你好")
    expect(id).not.toContain("=")
    expect(decodeSurfaceId(id)).toBe("@fixture/你好")
    expect(() => decodeSurfaceId(`${id}=`)).toThrow(/matching/)
  })

  it.effect("hash is stable and covers runtime and web bytes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const first = yield* readWebSurfaceCandidate(root)
      expect((yield* readWebSurfaceCandidate(root))?.candidateHash).toBe(first?.candidateHash)
      yield* Effect.promise(() => writeFile(path.join(root, "dist/pi/extension.js"), "export default () => 1\n"))
      expect((yield* readWebSurfaceCandidate(root))?.candidateHash).not.toBe(first?.candidateHash)
      const second = yield* readWebSurfaceCandidate(root)
      yield* Effect.promise(() => writeFile(path.join(root, "dist/web/app.js"), "export const answer = 43\n"))
      expect((yield* readWebSurfaceCandidate(root))?.candidateHash).not.toBe(second?.candidateHash)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("rejects escaping web symlinks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const outsideRoot = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pipee-outside-")))
      const outside = path.join(outsideRoot, "secret.js")
      yield* Effect.promise(() => writeFile(outside, "secret"))
      yield* Effect.promise(() => symlink(outside, path.join(root, "dist/web/escape.js")))
      const error = yield* readWebSurfaceCandidate(root).pipe(Effect.flip)
      expect(error.message).toMatch(/escapes package root/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("does not admit a retired manifest namespace", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const packagePath = path.join(root, "package.json")
      const pkg = yield* Effect.promise(() => readFile(packagePath, "utf8").then(JSON.parse))
      const retiredKey = ["pi", "Su", "ite"].join("")
      pkg[retiredKey] = pkg.pipee
      delete pkg.pipee
      yield* Effect.promise(() => writeFile(packagePath, JSON.stringify(pkg)))
      expect(yield* readWebSurfaceCandidate(root)).toBeNull()
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("rejects a retired surface contract under the Pipee namespace", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const packagePath = path.join(root, "package.json")
      const pkg = yield* Effect.promise(() => readFile(packagePath, "utf8").then(JSON.parse))
      pkg.pipee.web.contract = `${["pi", "suite"].join("-")}/web-surface@1`
      yield* Effect.promise(() => writeFile(packagePath, JSON.stringify(pkg)))
      const failure = yield* readWebSurfaceCandidate(root).pipe(Effect.flip)
      expect(failure.message).toContain("pipee/web-surface@2")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("binds browser companion evidence and bytes into the candidate", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      yield* Effect.promise(() => addBrowserCompanion(root))
      const first = yield* readWebSurfaceCandidate(root)
      expect(first?.browserCompanion?.expectation).toMatchObject({
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        displayVersion: "1.2.3",
      })
      yield* Effect.promise(() =>
        writeFile(path.join(root, "dist/browser-extension/service-worker.js"), "export const candidate = 2\n"),
      )
      expect((yield* readWebSurfaceCandidate(root))?.candidateHash).not.toBe(first?.candidateHash)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("rejects browser companion evidence outside its declared directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(fixture)
      const packagePath = path.join(root, "package.json")
      const pkg = yield* Effect.promise(() => readFile(packagePath, "utf8").then(JSON.parse))
      pkg.pipee.browserCompanion = {
        contract: "pipee/browser-companion@2",
        directory: "./dist/browser-extension",
        evidence: "./dist/web/evidence.json",
      }
      yield* Effect.promise(() => writeFile(packagePath, JSON.stringify(pkg)))
      const failure = yield* readWebSurfaceCandidate(root).pipe(Effect.flip)
      expect(failure.message).toContain("evidence must be inside")
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
