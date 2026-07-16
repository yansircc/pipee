import { Context, Data, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppConfig } from "./app-config"

export interface ProjectResolution {
  readonly projectRoot: string
  readonly branch: string | null
  readonly isWorktree: boolean
  readonly isTopLevel: boolean
}

export interface WorktreeRecord {
  readonly path: string
  readonly branch: string | null
  readonly isMain: boolean
}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly operation: string
  readonly message: string
  readonly dirtyPath?: string
}> {}

interface CommandResult {
  readonly code: number
  readonly output: string
}

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly home: string
    readonly resolveProject: (cwd: string) => Effect.Effect<ProjectResolution, WorkspaceError>
    readonly listWorktrees: (cwd: string) => Effect.Effect<ReadonlyArray<WorktreeRecord>, WorkspaceError>
    readonly createWorktree: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<{ readonly path: string; readonly branch: string }, WorkspaceError>
    readonly removeWorktree: (cwd: string, worktreePath: string, force: boolean) => Effect.Effect<void, WorkspaceError>
  }
>()("pi-web/server/WorkspaceService") {}

const layerEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const config = yield* AppConfig
  const canonicalPath = (value: string) => path.resolve(value)

  const fileOp = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError((cause) => new WorkspaceError({ operation, message: String(cause) })))

  const run = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<CommandResult, WorkspaceError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("git", ["-C", cwd, ...args], {
              env: { LC_ALL: "C" },
              extendEnv: true,
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError((cause) => new WorkspaceError({ operation: "git.spawn", message: String(cause) })),
          )
        const output = yield* handle.all.pipe(
          Stream.decodeText,
          Stream.mkString,
          Effect.mapError((cause) => new WorkspaceError({ operation: "git.output", message: String(cause) })),
        )
        const code = yield* handle.exitCode.pipe(
          Effect.map(Number),
          Effect.mapError((cause) => new WorkspaceError({ operation: "git.exit", message: String(cause) })),
        )
        return { code, output: output.trim() }
      }),
    )

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* run(cwd, args)
      if (result.code !== 0) {
        return yield* new WorkspaceError({
          operation: `git ${args[0] ?? ""}`.trim(),
          message: result.output || `git exited with ${result.code}`,
        })
      }
      return result.output
    })

  const inferRemovedWorktree = (cwd: string): Effect.Effect<ProjectResolution | null, WorkspaceError> =>
    Effect.gen(function* () {
      const parent = path.dirname(cwd)
      if (!parent.endsWith("-worktrees")) return null
      const projectRoot = parent.slice(0, -"-worktrees".length)
      if (!projectRoot || !(yield* fileOp("project.exists", fs.exists(path.join(projectRoot, ".git"))))) return null
      return {
        projectRoot,
        branch: path.basename(cwd),
        isWorktree: true,
        isTopLevel: true,
      }
    })

  const resolveProject = (cwd: string): Effect.Effect<ProjectResolution, WorkspaceError> =>
    Effect.gen(function* () {
      if (!(yield* fileOp("project.exists", fs.exists(cwd)))) {
        return (
          (yield* inferRemovedWorktree(cwd)) ?? {
            projectRoot: cwd,
            branch: null,
            isWorktree: false,
            isTopLevel: false,
          }
        )
      }
      const output = yield* git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-dir",
        "--show-toplevel",
        "--abbrev-ref",
        "HEAD",
      ]).pipe(Effect.catch(() => Effect.succeed("")))
      const [rawCommonDir, rawGitDir, rawTopLevel, ref] = output.split("\n").map((line) => line.trim())
      if (!rawCommonDir || !rawGitDir || !rawTopLevel) {
        return { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false }
      }
      const commonDir = canonicalPath(rawCommonDir)
      const gitDir = canonicalPath(rawGitDir)
      const topLevel = canonicalPath(rawTopLevel)
      const realCwd = yield* fileOp("project.realPath", fs.realPath(cwd)).pipe(
        Effect.map(canonicalPath),
        Effect.catch(() => Effect.succeed(canonicalPath(cwd))),
      )
      const isTopLevel = topLevel === realCwd
      const isWorktree = gitDir !== commonDir && isTopLevel
      return {
        projectRoot: isWorktree ? path.dirname(commonDir) : cwd,
        branch: ref && ref !== "HEAD" ? ref : null,
        isWorktree,
        isTopLevel,
      }
    })

  const listWorktrees = (cwd: string): Effect.Effect<ReadonlyArray<WorktreeRecord>, WorkspaceError> =>
    Effect.gen(function* () {
      const output = yield* git(cwd, ["worktree", "list", "--porcelain"])
      const records: Array<WorktreeRecord> = []
      let current: { path?: string; branch?: string; prunable?: boolean } | null = null
      const flush = Effect.gen(function* () {
        const candidate = current
        if (candidate?.path !== undefined) {
          const candidatePath = canonicalPath(candidate.path)
          if (!candidate.prunable && (yield* fileOp("worktree.exists", fs.exists(candidatePath)))) {
            records.push({
              path: candidatePath,
              branch: candidate.branch ?? null,
              isMain: records.length === 0,
            })
          }
        }
        current = null
      })
      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          yield* flush
          current = { path: line.slice("worktree ".length).trim() }
        } else if (line.startsWith("branch ") && current !== null) {
          current.branch = line
            .slice("branch ".length)
            .trim()
            .replace(/^refs\/heads\//, "")
        } else if (line.startsWith("prunable") && current !== null) {
          current.prunable = true
        } else if (line.trim() === "") {
          yield* flush
        }
      }
      yield* flush
      return records
    })

  const repoRoot = (cwd: string) =>
    Effect.map(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), (commonDir) =>
      path.dirname(canonicalPath(commonDir)),
    )

  const sanitizeBranch = (branch: string) => branch.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "")

  const createWorktree = (cwd: string, branch: string) =>
    Effect.gen(function* () {
      const normalized = branch.trim()
      const directoryName = sanitizeBranch(normalized)
      if (!normalized || !directoryName) {
        return yield* new WorkspaceError({ operation: "worktree.create", message: "A valid branch is required" })
      }
      const root = yield* repoRoot(cwd)
      const base = `${path.resolve(root)}-worktrees`
      const target = path.join(base, directoryName)
      if (yield* fileOp("worktree.exists", fs.exists(target))) {
        return yield* new WorkspaceError({
          operation: "worktree.create",
          message: `Directory already exists: ${target}`,
        })
      }
      yield* fs
        .makeDirectory(base, { recursive: true })
        .pipe(Effect.mapError((cause) => new WorkspaceError({ operation: "worktree.mkdir", message: String(cause) })))
      const branchExists = yield* git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${normalized}`]).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      yield* git(
        root,
        branchExists
          ? ["worktree", "add", "--", target, normalized]
          : ["worktree", "add", "-b", normalized, "--", target],
      )
      return { path: target, branch: normalized }
    })

  const removeWorktree = (cwd: string, target: string, force: boolean) =>
    Effect.gen(function* () {
      const canonicalTarget = canonicalPath(target)
      const worktrees = yield* listWorktrees(cwd)
      const record = worktrees.find((worktree) => worktree.path === canonicalTarget)
      if (record === undefined) {
        return yield* new WorkspaceError({
          operation: "worktree.remove",
          message: `Not a worktree: ${canonicalTarget}`,
        })
      }
      if (record.isMain) {
        return yield* new WorkspaceError({ operation: "worktree.remove", message: "Cannot remove the main worktree" })
      }
      const result = yield* run(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), canonicalTarget])
      if (result.code === 0) return
      const dirty = /modified or untracked files|contains modified|is dirty/i.test(result.output)
      return yield* new WorkspaceError({
        operation: "worktree.remove",
        message: result.output || `git exited with ${result.code}`,
        ...(dirty ? { dirtyPath: canonicalTarget } : {}),
      })
    })

  return WorkspaceService.of({
    home: config.home,
    resolveProject,
    listWorktrees,
    createWorktree,
    removeWorktree,
  })
})

export const WorkspaceServiceLive: Layer.Layer<
  WorkspaceService,
  never,
  AppConfig | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(WorkspaceService, layerEffect)
