import { createHash } from "node:crypto"
import { Context, Data, Effect, FileSystem, Path, Schema } from "effect"
import {
  CandidateHash,
  SurfaceId,
  WebSurfaceManifest,
  type WebSurfaceManifest as WebSurfaceManifestValue,
} from "@pi-suite/companion-contracts/web-surface"
import type { PluginsResponse } from "@/api/contract"

export class WebSurfaceCandidateError extends Data.TaggedError("WebSurfaceCandidateError")<{
  readonly message: string
}> {}

export interface WebSurfaceCandidate {
  readonly packageName: string
  readonly surfaceId: SurfaceId
  readonly candidateHash: CandidateHash
  readonly packageRoot: string
  readonly webRoot: string
  readonly documentPath: string
  readonly manifest: WebSurfaceManifestValue
  readonly files: ReadonlyArray<string>
}

const decodeManifest = Schema.decodeUnknownSync(WebSurfaceManifest)
const decodePackageName = Schema.decodeUnknownSync(Schema.NonEmptyString)
const decodeImpossible = Schema.decodeUnknownSync(Schema.Never)
const fail = (message: string): never => decodeImpossible(new WebSurfaceCandidateError({ message }))

const normalizedRelative = (value: string, field: string): string => {
  if (value.startsWith("/") || value.includes("\\")) return fail(`${field} must be a POSIX relative path`)
  const stripped = value.startsWith("./") ? value.slice(2) : value
  const parts = stripped.split("/")
  if (!stripped || parts.includes("") || parts.includes(".") || parts.includes("..")) {
    return fail(`${field} is not a canonical relative path`)
  }
  return stripped
}

const within = (path: Context.Service.Shape<typeof Path.Path>, root: string, value: string): boolean =>
  value === root || value.startsWith(`${root}${path.sep}`)

const mapFsError = (message: string) => () => new WebSurfaceCandidateError({ message })

const admittedFile = (root: string, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lexical = path.resolve(root, ...relative.split("/"))
    if (!within(path, root, lexical))
      return yield* new WebSurfaceCandidateError({ message: `Path escapes package root: ${relative}` })
    const resolved = yield* fs
      .realPath(lexical)
      .pipe(Effect.mapError(mapFsError(`Missing candidate file: ${relative}`)))
    if (!within(path, root, resolved))
      return yield* new WebSurfaceCandidateError({ message: `Symlink escapes package root: ${relative}` })
    const target = yield* fs.stat(resolved).pipe(Effect.mapError(mapFsError(`Missing candidate file: ${relative}`)))
    if (target.type !== "File")
      return yield* new WebSurfaceCandidateError({ message: `Candidate path is not a file: ${relative}` })
    return resolved
  })

const walkWebFiles = (
  root: string,
  directory = "dist/web",
): Effect.Effect<ReadonlyArray<string>, WebSurfaceCandidateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absolute = path.resolve(root, ...directory.split("/"))
    const resolved = yield* fs.realPath(absolute).pipe(Effect.mapError(mapFsError("Missing dist/web directory")))
    if (!within(path, root, resolved))
      return yield* new WebSurfaceCandidateError({ message: "dist/web symlink escapes package root" })
    const names = yield* fs
      .readDirectory(resolved)
      .pipe(Effect.mapError(mapFsError("Unable to read dist/web directory")))
    const nested = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const relative = `${directory}/${name}`
          const lexical = path.join(resolved, name)
          const canonical = yield* fs
            .realPath(lexical)
            .pipe(Effect.mapError(mapFsError(`Missing candidate path: ${relative}`)))
          if (!within(path, root, canonical))
            return yield* new WebSurfaceCandidateError({ message: `Symlink escapes package root: ${relative}` })
          const info = yield* fs
            .stat(canonical)
            .pipe(Effect.mapError(mapFsError(`Missing candidate path: ${relative}`)))
          if (info.type === "Directory") return yield* walkWebFiles(root, relative)
          if (info.type !== "File")
            return yield* new WebSurfaceCandidateError({ message: `Unsupported archive entry: ${relative}` })
          yield* admittedFile(root, relative)
          return [relative]
        }),
      { concurrency: 8 },
    )
    return nested.flat().sort()
  })

export const encodeSurfaceId = (packageName: string): SurfaceId =>
  SurfaceId.make(Buffer.from(decodePackageName(packageName), "utf8").toString("base64url"))

export const decodeSurfaceId = (surfaceId: string): string => {
  const decoded = Buffer.from(SurfaceId.make(surfaceId), "base64url").toString("utf8")
  return encodeSurfaceId(decoded) === surfaceId ? decoded : fail("Non-canonical surface id")
}

const extensionEntries = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value
  return fail("package.json pi.extensions must be a string or string array")
}

export const readWebSurfaceCandidate = (inputRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const packageRoot = yield* fs.realPath(inputRoot).pipe(Effect.mapError(mapFsError("Package root is missing")))
    const packageJsonPath = yield* admittedFile(packageRoot, "package.json")
    const packageText = yield* fs
      .readFileString(packageJsonPath)
      .pipe(Effect.mapError(mapFsError("Unable to read package.json")))
    const raw = yield* Effect.try({
      try: () => JSON.parse(packageText) as unknown,
      catch: () => new WebSurfaceCandidateError({ message: "Invalid package.json" }),
    })
    if (typeof raw !== "object" || raw === null)
      return yield* new WebSurfaceCandidateError({ message: "Invalid package.json" })
    const pkg = raw as Record<string, unknown>
    const piSuite = pkg.piSuite
    const web = typeof piSuite === "object" && piSuite !== null ? (piSuite as Record<string, unknown>).web : undefined
    if (web === undefined) return null
    const manifest = yield* Effect.try({
      try: () => decodeManifest(web),
      catch: (error) => new WebSurfaceCandidateError({ message: String(error) }),
    })
    const packageName = yield* Effect.try({
      try: () => decodePackageName(pkg.name),
      catch: () => new WebSurfaceCandidateError({ message: "Web surface package requires a name" }),
    })
    const pi = pkg.pi
    const extensions = extensionEntries(
      typeof pi === "object" && pi !== null ? (pi as Record<string, unknown>).extensions : undefined,
    ).map((value, index) => normalizedRelative(value, `pi.extensions[${index}]`))
    const document = normalizedRelative(manifest.document, "piSuite.web.document")
    if (!document.startsWith("dist/web/"))
      return yield* new WebSurfaceCandidateError({ message: "Web document must be inside dist/web" })
    const files = ["package.json", ...extensions, ...(yield* walkWebFiles(packageRoot))]
    const unique = [...new Set(files)].sort()
    yield* Effect.forEach(unique, (relative) => admittedFile(packageRoot, relative), { concurrency: 8, discard: true })
    if (!unique.includes(document))
      return yield* new WebSurfaceCandidateError({ message: "Web document is missing from candidate" })
    const hash = createHash("sha256")
    yield* Effect.forEach(
      unique,
      (relative) =>
        fs.readFile(path.resolve(packageRoot, ...relative.split("/"))).pipe(
          Effect.mapError(mapFsError(`Unable to read candidate file: ${relative}`)),
          Effect.tap((bytes) =>
            Effect.sync(() => {
              hash.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`)
              hash.update(bytes)
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    )
    const candidateHash = CandidateHash.make(hash.digest("hex"))
    return {
      packageName,
      surfaceId: encodeSurfaceId(packageName),
      candidateHash,
      packageRoot,
      webRoot: path.join(packageRoot, "dist", "web"),
      documentPath: path.resolve(packageRoot, ...document.split("/")),
      manifest,
      files: unique,
    } satisfies WebSurfaceCandidate
  })

export const assertUniqueWebSurfaceCandidates = (
  candidates: ReadonlyArray<WebSurfaceCandidate>,
): ReadonlyMap<string, WebSurfaceCandidate> => {
  const result = new Map<string, WebSurfaceCandidate>()
  for (const candidate of candidates) {
    if (result.has(candidate.packageName)) return fail(`Duplicate package name: ${candidate.packageName}`)
    result.set(candidate.packageName, candidate)
  }
  return result
}

export const findWebSurfaceCandidateForExtension = (extensionPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const loaded = yield* fs
      .realPath(extensionPath)
      .pipe(Effect.mapError(mapFsError("Loaded extension path is missing")))
    const inspect = (
      current: string,
    ): Effect.Effect<WebSurfaceCandidate | null, WebSurfaceCandidateError, FileSystem.FileSystem | Path.Path> =>
      fs.access(path.join(current, "package.json")).pipe(
        Effect.matchEffect({
          onFailure: () => {
            const parent = path.dirname(current)
            return parent === current ? Effect.succeed(null) : inspect(parent)
          },
          onSuccess: () =>
            readWebSurfaceCandidate(current).pipe(
              Effect.flatMap((candidate) => {
                if (candidate === null) return Effect.succeed(null)
                const runtimeFiles = candidate.files.filter(
                  (relative) => relative !== "package.json" && !relative.startsWith("dist/web/"),
                )
                return Effect.forEach(
                  runtimeFiles,
                  (relative) => fs.realPath(path.resolve(current, ...relative.split("/"))),
                  { concurrency: 8 },
                ).pipe(
                  Effect.mapError(mapFsError("Unable to resolve runtime candidate")),
                  Effect.map((runtimePaths) => (runtimePaths.includes(loaded) ? candidate : null)),
                )
              }),
            ),
        }),
      )
    return yield* inspect(path.dirname(loaded))
  })

export const packageSetFingerprint = (projection: PluginsResponse) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hash = createHash("sha256")
    const packages = projection.packages
      .filter((pkg) => pkg.status === "loaded" && !pkg.disabled && pkg.counts.extensions > 0)
      .toSorted((a, b) => `${a.scope}:${a.source}`.localeCompare(`${b.scope}:${b.source}`))
    for (const pkg of packages) {
      hash.update(JSON.stringify([pkg.scope, pkg.source, pkg.packageName ?? null, pkg.installedPath ?? null]))
      const resources = pkg.resources
        .filter((item) => item.kind === "extension")
        .toSorted((a, b) => a.path.localeCompare(b.path))
      yield* Effect.forEach(
        resources,
        (resource) =>
          fs.readFile(resource.path).pipe(
            Effect.mapError(mapFsError(`Unable to read extension resource: ${resource.relativePath}`)),
            Effect.tap((bytes) =>
              Effect.sync(() => {
                hash.update(`${resource.relativePath}:${bytes.length}:`)
                hash.update(bytes)
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      )
      if (pkg.installedPath !== undefined) {
        const candidate = yield* readWebSurfaceCandidate(pkg.installedPath)
        if (candidate !== null) hash.update(candidate.candidateHash)
      }
    }
    return hash.digest("hex")
  })
