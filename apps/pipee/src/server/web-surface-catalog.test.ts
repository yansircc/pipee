import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { PiAgentAdapter } from "./pi-agent-adapter"
import { SessionRepository } from "./session-repository"
import { SessionRuntimeRegistry } from "./session-runtime-registry"
import { WebSurfaceCatalog, WebSurfaceCatalogLive } from "./web-surface-catalog"

const sessionId = "session"

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipee-catalog-"))
  await mkdir(path.join(root, "dist/pi"), { recursive: true })
  await mkdir(path.join(root, "dist/web"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@fixture/web-surface",
      pi: { extensions: "./dist/pi/extension.js" },
      pipee: { web: { contract: "pipee/web-surface@2", document: "./dist/web/index.html", title: "Fixture" } },
    }),
  )
  await writeFile(path.join(root, "dist/pi/extension.js"), "export default () => {}\n")
  await writeFile(path.join(root, "dist/web/index.html"), "<main>fixture</main>\n")
  return root
}

const catalogLayer = (root: string, persisted: boolean) => {
  const repository = SessionRepository.of({
    snapshot: () =>
      persisted
        ? Effect.succeed({ info: { cwd: root } } as never)
        : Effect.fail({ notFoundId: sessionId, message: "Session is not persisted yet" } as never),
  } as never)
  const adapter = PiAgentAdapter.of({
    plugins: () =>
      Effect.succeed({
        packages: [
          {
            status: "loaded",
            disabled: false,
            installedPath: root,
            counts: { extensions: 1 },
          },
        ],
      }),
  } as never)
  const registry = SessionRuntimeRegistry.of({
    activeOption: () => Effect.succeed(persisted ? null : ({ runtime: { cwd: root } } as never)),
  } as never)
  return WebSurfaceCatalogLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(SessionRepository, repository),
        Layer.succeed(PiAgentAdapter, adapter),
        Layer.succeed(SessionRuntimeRegistry, registry),
      ),
    ),
  )
}

describe("web surface catalog", () => {
  it.effect("discovers a loaded package from a persisted Pi session", () =>
    Effect.promise(fixture).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const catalog = yield* WebSurfaceCatalog
          const result = yield* catalog.read(sessionId)
          expect(result.public.surfaces).toEqual([
            expect.objectContaining({
              packageName: "@fixture/web-surface",
              title: "Fixture",
              documentUrl: expect.stringContaining("/index.html"),
            }),
          ])
        }).pipe(Effect.provide(catalogLayer(root, true))),
      ),
    ),
  )

  it.effect("uses the active runtime only until the new Pi session is persisted", () =>
    Effect.promise(fixture).pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const catalog = yield* WebSurfaceCatalog
          const result = yield* catalog.read(sessionId)
          expect(result.public.surfaces).toHaveLength(1)
          expect(result.public.surfaces[0]?.packageName).toBe("@fixture/web-surface")
        }).pipe(Effect.provide(catalogLayer(root, false))),
      ),
    ),
  )
})
