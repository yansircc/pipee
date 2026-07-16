import { Context, Data, Effect, FileSystem, Layer, Path, Ref } from "effect"
import { PiAgentAdapter } from "./pi-agent-adapter"
import { WorkspaceService } from "./workspace-service"

export class FileAccessError extends Data.TaggedError("FileAccessError")<{
  readonly path: string
  readonly message: string
}> {}

export class FileAccessPolicy extends Context.Service<
  FileAccessPolicy,
  {
    readonly allowRoot: (root: string) => Effect.Effect<void>
    readonly admitExistingRoot: (root: string) => Effect.Effect<string, FileAccessError>
    readonly assertExisting: (target: string) => Effect.Effect<string, FileAccessError>
    readonly assertProspective: (target: string) => Effect.Effect<string, FileAccessError>
  }
>()("pi-web/server/FileAccessPolicy") {}

const layerEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const adapter = yield* PiAgentAdapter
  const workspace = yield* WorkspaceService
  const additionalRoots = yield* Ref.make<ReadonlySet<string>>(new Set())

  const allowRoot = (root: string) =>
    Ref.update(additionalRoots, (roots) => {
      const next = new Set(roots)
      next.add(path.resolve(root))
      return next
    })

  const roots = Effect.gen(function* () {
    const sessions = yield* adapter.listSessions.pipe(
      Effect.mapError((cause) => new FileAccessError({ path: "", message: cause.message })),
    )
    const projects = yield* Effect.forEach(
      [...new Set(sessions.map((session) => session.cwd).filter(Boolean))],
      (cwd) =>
        workspace.resolveProject(cwd).pipe(
          Effect.map((project) => [cwd, project.projectRoot] as const),
          Effect.catch(() => Effect.succeed([cwd, cwd] as const)),
        ),
      { concurrency: 8 },
    )
    const discovered = new Set<string>()
    for (const [cwd, project] of projects) {
      discovered.add(path.resolve(cwd))
      discovered.add(path.resolve(project))
    }
    const homeEntries = yield* fs.readDirectory(workspace.home).pipe(Effect.catch(() => Effect.succeed([])))
    for (const name of homeEntries) {
      if (/^pi-cwd-\d{8}$/.test(name)) discovered.add(path.join(workspace.home, name))
    }
    for (const root of yield* Ref.get(additionalRoots)) discovered.add(root)
    return discovered
  })

  const isWithin = (target: string, root: string): boolean => {
    const relative = path.relative(root, target)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  const canonicalExisting = (target: string) =>
    fs
      .realPath(path.resolve(target))
      .pipe(Effect.mapError(() => new FileAccessError({ path: target, message: "Path does not exist" })))

  const admitExistingRoot = (root: string) =>
    Effect.gen(function* () {
      const resolved = yield* canonicalExisting(root)
      yield* allowRoot(resolved)
      return resolved
    })

  const authorize = (target: string, existing: boolean) =>
    Effect.gen(function* () {
      const normalizedTarget = path.resolve(target)
      const resolvedTarget = existing ? yield* canonicalExisting(normalizedTarget) : normalizedTarget
      const allowed = yield* roots
      for (const root of allowed) {
        const resolvedRoot = yield* fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(path.resolve(root))))
        if (isWithin(resolvedTarget, resolvedRoot)) return resolvedTarget
      }
      return yield* new FileAccessError({ path: target, message: "Path is outside the allowed roots" })
    })

  return FileAccessPolicy.of({
    allowRoot,
    admitExistingRoot,
    assertExisting: (target) => authorize(target, true),
    assertProspective: (target) => authorize(target, false),
  })
})

export const FileAccessPolicyLive: Layer.Layer<
  FileAccessPolicy,
  never,
  FileSystem.FileSystem | Path.Path | PiAgentAdapter | WorkspaceService
> = Layer.effect(FileAccessPolicy, layerEffect)
