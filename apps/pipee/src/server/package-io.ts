import { Context, Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { zipSync } from "fflate"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { HttpClient } from "effect/unstable/http"
import { SkillSearchResult } from "@/api/contract"
import { AppConfig } from "./app-config"

const ansi = /\x1B\[[0-9;]*m/g

export class PackageIoError extends Data.TaggedError("PackageIoError")<{
  readonly operation: string
  readonly message: string
}> {}

export class PackageIo extends Context.Service<
  PackageIo,
  {
    readonly searchSkills: (
      query: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<typeof SkillSearchResult.Type>, PackageIoError>
    readonly installSkill: (
      packageName: string,
      scope: "global" | "project",
      cwd: string | undefined,
    ) => Effect.Effect<string, PackageIoError>
    readonly archiveDirectory: (directory: string) => Effect.Effect<Uint8Array, PackageIoError>
  }
>()("pipee/server/PackageIo") {}

const SearchResponse = Schema.Struct({
  skills: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        source: Schema.optionalKey(Schema.String),
        installs: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
})

const installCount = (value: string): number => {
  const match = value.match(/^([\d.]+)([KMB])?\s+installs?$/)
  if (match === null) return 0
  const count = Number(match[1])
  if (!Number.isFinite(count)) return 0
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1
  return count * multiplier
}

const formatInstalls = (count: number | undefined): string => {
  if (count === undefined || count <= 0) return ""
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`
  return `${count} install${count === 1 ? "" : "s"}`
}

const parseCliSearch = (raw: string): ReadonlyArray<typeof SkillSearchResult.Type> => {
  const lines = raw.replace(ansi, "").split("\n")
  const results: Array<typeof SkillSearchResult.Type> = []
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.trim().match(/^([\w.-]+\/[\w.@:-]+)\s+([\d.,]+[KMB]?\s+installs)$/)
    if (match === null || match === undefined) continue
    const url = lines[index + 1]?.trim().replace(/^└\s*/, "") ?? ""
    results.push(
      SkillSearchResult.make({
        package: match[1]!,
        installs: match[2]!,
        url: url.startsWith("https://") ? url : "",
      }),
    )
  }
  return results
}

const layerEffect = Effect.gen(function* () {
  const config = yield* AppConfig
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const http = yield* HttpClient.HttpClient
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const archiveDirectory = (directory: string) =>
    Effect.gen(function* () {
      const entries: Record<string, Uint8Array> = {}
      const visit = (current: string, relative: string): Effect.Effect<void, PackageIoError> =>
        Effect.gen(function* () {
          const names = yield* fs
            .readDirectory(current)
            .pipe(
              Effect.mapError(
                (cause) => new PackageIoError({ operation: "chrome-extension.archive.read", message: String(cause) }),
              ),
            )
          yield* Effect.forEach(
            names,
            (name) =>
              Effect.gen(function* () {
                const fullPath = path.join(current, name)
                const entryPath = relative ? `${relative}/${name}` : name
                const info = yield* fs
                  .stat(fullPath)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new PackageIoError({ operation: "chrome-extension.archive.stat", message: String(cause) }),
                    ),
                  )
                if (info.type === "Directory") return yield* visit(fullPath, entryPath)
                if (info.type !== "File") {
                  return yield* new PackageIoError({
                    operation: "chrome-extension.archive.entry",
                    message: `Unsupported archive entry: ${entryPath}`,
                  })
                }
                entries[entryPath] = yield* fs
                  .readFile(fullPath)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new PackageIoError({ operation: "chrome-extension.archive.file", message: String(cause) }),
                    ),
                  )
              }),
            { concurrency: 8, discard: true },
          )
        })
      yield* visit(directory, "")
      return yield* Effect.try({
        try: () => zipSync(entries, { level: 6 }),
        catch: (cause) => new PackageIoError({ operation: "chrome-extension.archive.zip", message: String(cause) }),
      })
    })

  const runNpx = (args: ReadonlyArray<string>, cwd: string | undefined, timeout: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = config.platform === "win32" ? "npx.cmd" : "npx"
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(command, args, {
              ...(cwd === undefined ? {} : { cwd }),
              env: { FORCE_COLOR: "0" },
              extendEnv: true,
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(
            Effect.timeout(timeout),
            Effect.mapError((cause) => new PackageIoError({ operation: "npx.spawn", message: String(cause) })),
          )
        const output = yield* handle.all.pipe(
          Stream.decodeText,
          Stream.mkString,
          Effect.mapError((cause) => new PackageIoError({ operation: "npx.output", message: String(cause) })),
        )
        const code = yield* handle.exitCode.pipe(
          Effect.map(Number),
          Effect.mapError((cause) => new PackageIoError({ operation: "npx.exit", message: String(cause) })),
        )
        if (code !== 0) {
          return yield* new PackageIoError({ operation: "npx", message: output.replace(ansi, "").slice(-500) })
        }
        return output.replace(ansi, "")
      }),
    )

  const searchHttp = (query: string, limit: number) =>
    Effect.gen(function* () {
      const url = new URL("/api/search", config.skillsApiUrl)
      url.searchParams.set("q", query)
      url.searchParams.set("limit", String(limit))
      const response = yield* http
        .get(url)
        .pipe(
          Effect.mapError((cause) => new PackageIoError({ operation: "skills.search.http", message: String(cause) })),
        )
      if (response.status < 200 || response.status >= 300) {
        return yield* new PackageIoError({
          operation: "skills.search.http",
          message: `skills.sh returned HTTP ${response.status}`,
        })
      }
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => new PackageIoError({ operation: "skills.search.json", message: String(cause) })),
      )
      const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)(json).pipe(
        Effect.mapError((cause) => new PackageIoError({ operation: "skills.search.decode", message: String(cause) })),
      )
      return (decoded.skills ?? [])
        .flatMap((skill) => {
          const name = skill.name?.trim()
          const source = skill.source?.trim()
          const slug = skill.id?.trim()
          if (!name || (!source && !slug)) return []
          return [
            SkillSearchResult.make({
              package: `${source || slug}@${name}`,
              installs: formatInstalls(skill.installs),
              url: slug ? new URL(slug, `${config.skillsApiUrl}/`).href : "",
            }),
          ]
        })
        .sort((left, right) => installCount(right.installs) - installCount(left.installs))
    })

  const searchSkills = (query: string, limit: number) =>
    searchHttp(query, limit).pipe(
      Effect.catch(() =>
        runNpx(["skills", "find", query], undefined, 20_000).pipe(
          Effect.map((output) => parseCliSearch(output).slice(0, limit)),
        ),
      ),
    )

  const installSkill = (packageName: string, scope: "global" | "project", cwd: string | undefined) => {
    const global = scope === "global"
    const args = ["skills", "add", packageName, "-y", "--agent", "pi", ...(global ? ["-g"] : [])]
    return runNpx(args, global ? undefined : cwd, 60_000).pipe(
      Effect.flatMap((output) =>
        /Installation complete|Installed \d+ skill/.test(output)
          ? Effect.succeed(output)
          : Effect.fail(
              new PackageIoError({ operation: "skills.install", message: output.slice(-500) || "Install failed" }),
            ),
      ),
    )
  }

  return PackageIo.of({ searchSkills, installSkill, archiveDirectory })
})

export const PackageIoLive: Layer.Layer<
  PackageIo,
  never,
  AppConfig | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> = Layer.effect(PackageIo, layerEffect)
