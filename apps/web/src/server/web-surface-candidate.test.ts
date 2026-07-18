import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeSurfaceId, encodeSurfaceId, readWebSurfaceCandidate } from "./web-surface-candidate"

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-surface-"))
  await mkdir(path.join(root, "dist/pi"), { recursive: true })
  await mkdir(path.join(root, "dist/web"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@fixture/surface",
      pi: { extensions: "./dist/pi/extension.js" },
      piSuite: { web: { contract: "pi-suite/web-surface@1", document: "./dist/web/index.html", title: "Fixture" } },
    }),
  )
  await writeFile(path.join(root, "dist/pi/extension.js"), "export default () => {}\n")
  await writeFile(path.join(root, "dist/web/index.html"), "<script type=module src=./app.js></script>")
  await writeFile(path.join(root, "dist/web/app.js"), "export const answer = 42\n")
  return root
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
      const outsideRoot = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pi-web-outside-")))
      const outside = path.join(outsideRoot, "secret.js")
      yield* Effect.promise(() => writeFile(outside, "secret"))
      yield* Effect.promise(() => symlink(outside, path.join(root, "dist/web/escape.js")))
      const error = yield* readWebSurfaceCandidate(root).pipe(Effect.flip)
      expect(error.message).toMatch(/escapes package root/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
