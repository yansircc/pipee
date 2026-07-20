import { Context, Data, Effect, FileSystem, Layer, Path, Result } from "effect"
import {
  WebSurfaceCatalog as WebSurfaceCatalogSchema,
  WebSurfaceCatalogItem,
} from "@pipee/companion-contracts/web-surface"
import { PiAgentAdapter } from "./pi-agent-adapter"
import { SessionRepository } from "./session-repository"
import {
  WebSurfaceCandidateError,
  assertUniqueWebSurfaceCandidates,
  readWebSurfaceCandidate,
  type WebSurfaceCandidate,
} from "./web-surface-candidate"

export class WebSurfaceCatalogError extends Data.TaggedError("WebSurfaceCatalogError")<{
  readonly operation: string
  readonly message: string
  readonly notFound?: boolean
}> {}

export interface AdmittedWebSurface {
  readonly candidate: WebSurfaceCandidate
  readonly item: typeof WebSurfaceCatalogItem.Type
}

export interface AdmittedWebSurfaceCatalog {
  readonly public: typeof WebSurfaceCatalogSchema.Type
  readonly admitted: ReadonlyMap<string, AdmittedWebSurface>
  readonly fingerprint: string
}

export class WebSurfaceCatalog extends Context.Service<
  WebSurfaceCatalog,
  {
    readonly read: (sessionId: string) => Effect.Effect<AdmittedWebSurfaceCatalog, WebSurfaceCatalogError>
  }
>()("pipee/server/WebSurfaceCatalog") {}

const live = Effect.gen(function* () {
  const sessions = yield* SessionRepository
  const adapter = yield* PiAgentAdapter
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const readCandidate = (root: string) =>
    readWebSurfaceCandidate(root).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )
  return WebSurfaceCatalog.of({
    read: (sessionId) =>
      Effect.gen(function* () {
        const snapshot = yield* sessions.snapshot(sessionId, { limit: 1, deferMedia: true }).pipe(
          Effect.mapError(
            (error) =>
              new WebSurfaceCatalogError({
                operation: "catalog.session",
                message: error.message,
                ...(error.notFoundId === undefined ? {} : { notFound: true }),
              }),
          ),
        )
        const cwd = snapshot.info?.cwd
        if (cwd === undefined) {
          return yield* new WebSurfaceCatalogError({
            operation: "catalog.session",
            message: "Session workspace is unavailable",
            notFound: true,
          })
        }
        const plugins = yield* adapter
          .plugins(cwd)
          .pipe(
            Effect.mapError(
              (error) => new WebSurfaceCatalogError({ operation: "catalog.plugins", message: error.message }),
            ),
          )
        const diagnostics: Array<{ packageName?: string; message: string }> = []
        const candidates = yield* Effect.forEach(
          plugins.packages.filter(
            (pkg) =>
              pkg.status === "loaded" && !pkg.disabled && pkg.installedPath !== undefined && pkg.counts.extensions > 0,
          ),
          (pkg) =>
            Effect.result(readCandidate(pkg.installedPath!)).pipe(
              Effect.map((result) => {
                if (Result.isSuccess(result)) return result.success
                diagnostics.push({
                  ...(pkg.packageName === undefined ? {} : { packageName: pkg.packageName }),
                  message: result.failure.message,
                })
                return null
              }),
            ),
          { concurrency: 8 },
        )
        const uniqueResult = yield* Effect.result(
          Effect.try({
            try: () => assertUniqueWebSurfaceCandidates(candidates.filter((value) => value !== null)),
            catch: (error) =>
              error instanceof WebSurfaceCandidateError
                ? error
                : new WebSurfaceCandidateError({ message: String(error) }),
          }),
        )
        const unique = Result.isSuccess(uniqueResult) ? uniqueResult.success : new Map<string, WebSurfaceCandidate>()
        if (Result.isFailure(uniqueResult)) diagnostics.push({ message: uniqueResult.failure.message })
        const admitted = new Map<string, AdmittedWebSurface>()
        for (const candidate of unique.values()) {
          const item = WebSurfaceCatalogItem.make({
            packageName: candidate.packageName,
            surfaceId: candidate.surfaceId,
            candidateHash: candidate.candidateHash,
            title: candidate.manifest.title,
            documentUrl: `/extension-assets/${encodeURIComponent(sessionId)}/${candidate.surfaceId}/${candidate.candidateHash}/${candidate.manifest.document.slice("./dist/web/".length)}`,
            ...(candidate.browserCompanion === undefined
              ? {}
              : { browserCompanion: candidate.browserCompanion.expectation }),
          })
          admitted.set(candidate.surfaceId, { candidate, item })
        }
        const surfaces = [...admitted.values()]
          .map(({ item }) => item)
          .sort((a, b) => a.packageName.localeCompare(b.packageName))
        return {
          public: WebSurfaceCatalogSchema.make({ surfaces, diagnostics }),
          admitted,
          fingerprint: surfaces.map((surface) => `${surface.packageName}:${surface.candidateHash}`).join("\n"),
        }
      }),
  })
})

export const WebSurfaceCatalogLive = Layer.effect(WebSurfaceCatalog, live)
