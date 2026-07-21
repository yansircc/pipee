import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import mammoth from "mammoth"
import { FileContent, FileMeta, FileNode, FileWatchEvent, StoredAttachment } from "@/api/contract"
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "@/lib/file-types"
import { filterFileEntries, type FileIndexEntry } from "@/lib/file-fuzzy"
import { AppConfig } from "./app-config"
import { FileAccessPolicy } from "./file-access-policy"
import { WorkspaceService } from "./workspace-service"

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_INDEX_FILES = 5_000
const MAX_QUERY_LENGTH = 500
const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
])

export class WorkspaceIoError extends Data.TaggedError("WorkspaceIoError")<{
  readonly operation: string
  readonly message: string
  readonly notFoundPath?: string
  readonly forbiddenPath?: string
  readonly tooLargeLimit?: number
  readonly unsupportedPlatform?: string
}> {}

export class WorkspaceIo extends Context.Service<
  WorkspaceIo,
  {
    readonly validateCwd: (input: string) => Effect.Effect<string, WorkspaceIoError>
    readonly pickCwd: Effect.Effect<string | null, WorkspaceIoError>
    readonly defaultCwd: Effect.Effect<string, WorkspaceIoError>
    readonly listFiles: (
      root: string,
      query?: string,
      recursive?: boolean,
    ) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<typeof FileNode.Type>
        readonly truncated: boolean
      },
      WorkspaceIoError
    >
    readonly readFile: (target: string) => Effect.Effect<typeof FileContent.Type, WorkspaceIoError>
    readonly fileMeta: (target: string) => Effect.Effect<typeof FileMeta.Type, WorkspaceIoError>
    readonly previewFile: (target: string) => Effect.Effect<typeof FileContent.Type, WorkspaceIoError>
    readonly watchFile: (
      target: string,
    ) => Effect.Effect<Stream.Stream<typeof FileWatchEvent.Type, WorkspaceIoError>, WorkspaceIoError>
    readonly downloadFile: (
      target: string,
    ) => Effect.Effect<Stream.Stream<Uint8Array, WorkspaceIoError>, WorkspaceIoError>
    readonly storeAttachments: (
      attachments: ReadonlyArray<{ readonly name: string; readonly mimeType: string; readonly data: string }>,
    ) => Effect.Effect<ReadonlyArray<typeof StoredAttachment.Type>, WorkspaceIoError>
  }
>()("pipee/server/WorkspaceIo") {}

const languageByExtension: Readonly<Record<string, string>> = {
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  json: "application/json",
  jsonl: "application/x-ndjson",
  md: "text/markdown",
  mdx: "text/markdown",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
}

const contentType = (target: string): string =>
  getImageMime(target) ??
  getAudioMime(target) ??
  getDocumentMime(target) ??
  languageByExtension[getFileExt(target)] ??
  "text/plain"

const modifiedIso = (info: FileSystem.File.Info): string =>
  Option.match(info.mtime, {
    onNone: () => "",
    onSome: (date) => date.toISOString(),
  })

const wrapDocx = (body: string, name: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light}html,body{margin:0;min-height:100%;background:#eef1f5;color:#171717}body{font-family:system-ui,sans-serif;padding:28px}main{box-sizing:border-box;max-width:840px;min-height:calc(100vh - 56px);margin:0 auto;padding:56px 64px;background:#fff;box-shadow:0 8px 28px #0f172a24}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
</head><body><main><div>${name.replace(/[&<>"']/g, "_")}</div>${body}</main></body></html>`

const layerEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const config = yield* AppConfig
  const policy = yield* FileAccessPolicy
  const workspace = yield* WorkspaceService

  const io = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError((cause) => new WorkspaceIoError({ operation, message: String(cause) })))
  const authorizeExisting = (target: string) =>
    policy.assertExisting(target).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceIoError({
            operation: "files.authorize",
            message: cause.message,
            forbiddenPath: cause.path,
          }),
      ),
    )

  const validateCwd = (input: string) =>
    Effect.gen(function* () {
      const trimmed = input.trim()
      if (!trimmed) return yield* new WorkspaceIoError({ operation: "cwd.validate", message: "Path is required" })
      const expanded =
        trimmed === "~"
          ? config.home
          : trimmed.startsWith("~/")
            ? path.join(config.home, trimmed.slice(2))
            : path.resolve(trimmed)
      const info = yield* fs.stat(expanded).pipe(
        Effect.mapError(
          () =>
            new WorkspaceIoError({
              operation: "cwd.validate",
              message: `Directory does not exist: ${trimmed}`,
              notFoundPath: expanded,
            }),
        ),
      )
      if (info.type !== "Directory") {
        return yield* new WorkspaceIoError({
          operation: "cwd.validate",
          message: `Path is not a directory: ${trimmed}`,
        })
      }
      return yield* io("cwd.admit", policy.admitExistingRoot(expanded))
    })

  const runPicker = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(command, args, {
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(Effect.mapError((cause) => new WorkspaceIoError({ operation: "cwd.pick", message: String(cause) })))
        const output = yield* handle.stdout.pipe(
          Stream.decodeText,
          Stream.mkString,
          Effect.mapError((cause) => new WorkspaceIoError({ operation: "cwd.pick", message: String(cause) })),
        )
        const code = yield* handle.exitCode.pipe(
          Effect.map(Number),
          Effect.mapError((cause) => new WorkspaceIoError({ operation: "cwd.pick", message: String(cause) })),
        )
        return code === 0 ? output.trim() || null : null
      }),
    )

  const pickCwd = Effect.gen(function* () {
    const selected =
      config.platform === "darwin"
        ? yield* runPicker("osascript", ["-e", 'POSIX path of (choose folder with prompt "Select workspace")'])
        : config.platform === "win32"
          ? yield* runPicker("powershell.exe", [
              "-NoProfile",
              "-Command",
              "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}",
            ])
          : config.platform === "linux"
            ? yield* runPicker("zenity", ["--file-selection", "--directory", "--title=Select workspace"])
            : yield* new WorkspaceIoError({
                operation: "cwd.pick",
                message: `Native folder picker is unsupported on ${config.platform}`,
                unsupportedPlatform: config.platform,
              })
    return selected === null ? null : yield* validateCwd(selected)
  })

  const defaultCwd = Effect.gen(function* () {
    const now = yield* DateTime.now
    const suffix = DateTime.formatIsoDateUtc(now).replace(/-/g, "")
    const target = path.join(config.home, `pi-cwd-${suffix}`)
    yield* io("cwd.default", fs.makeDirectory(target, { recursive: true }))
    yield* policy.allowRoot(target)
    return target
  })

  const listFiles = (root: string, rawQuery?: string, recursive = false) =>
    Effect.gen(function* () {
      const authorized = yield* authorizeExisting(root)
      const info = yield* io("files.stat", fs.stat(authorized))
      if (info.type !== "Directory")
        return yield* new WorkspaceIoError({ operation: "files.list", message: "Not a directory" })
      const query = rawQuery?.slice(0, MAX_QUERY_LENGTH).trim() ?? ""
      const names = yield* io("files.list", fs.readDirectory(authorized, { recursive: recursive || query.length > 0 }))
      const filtered = names.filter(
        (name) => name.split(/[\\/]/).every((part) => !IGNORED_NAMES.has(part)) && !name.endsWith(".pyc"),
      )
      const entries = yield* Effect.forEach(
        filtered,
        (name) =>
          Effect.gen(function* () {
            const target = path.join(authorized, name)
            const stat = yield* fs.stat(target).pipe(Effect.option)
            if (Option.isNone(stat)) return null
            return {
              name: path.basename(name),
              path: recursive || query ? name.replace(/\\/g, "/") : target,
              kind: stat.value.type === "Directory" ? ("directory" as const) : ("file" as const),
              size: Number(stat.value.size),
              modified: modifiedIso(stat.value),
            }
          }),
        { concurrency: 32 },
      )
      const existing = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      if (!query) {
        return {
          entries: existing.slice(0, MAX_INDEX_FILES).map((entry) => FileNode.make(entry)),
          truncated: existing.length > MAX_INDEX_FILES,
        }
      }
      const fuzzy: Array<FileIndexEntry> = existing.map((entry) => ({
        path: entry.path,
        isDir: entry.kind === "directory",
      }))
      const selected = new Set(filterFileEntries(fuzzy, query).map((entry) => entry.path))
      const matches = existing.filter((entry) => selected.has(entry.path))
      return {
        entries: matches.slice(0, MAX_INDEX_FILES).map((entry) => FileNode.make(entry)),
        truncated: matches.length > MAX_INDEX_FILES,
      }
    })

  const meta = (target: string) =>
    Effect.gen(function* () {
      const authorized = yield* authorizeExisting(target)
      const info = yield* io("files.stat", fs.stat(authorized))
      if (info.type !== "File") return yield* new WorkspaceIoError({ operation: "files.meta", message: "Not a file" })
      return { authorized, info }
    })

  const fileMeta = (target: string) =>
    Effect.map(meta(target), ({ authorized, info }) =>
      FileMeta.make({
        path: authorized,
        size: Number(info.size),
        modified: modifiedIso(info),
        contentType: contentType(authorized),
      }),
    )

  const readFile = (target: string) =>
    Effect.gen(function* () {
      const { authorized, info } = yield* meta(target)
      const size = Number(info.size)
      const mime = contentType(authorized)
      const binary = mime.startsWith("image/") || mime.startsWith("audio/") || getDocumentMime(authorized) !== null
      const limit = binary ? IMAGE_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES
      if (size > limit) {
        return yield* new WorkspaceIoError({
          operation: "files.read",
          message: `File exceeds preview limit of ${limit} bytes`,
          tooLargeLimit: limit,
        })
      }
      const bytes = yield* io("files.read", fs.readFile(authorized))
      return FileContent.make({
        path: authorized,
        contentType: mime,
        encoding: binary ? "base64" : "utf8",
        content: binary ? Encoding.encodeBase64(bytes) : new TextDecoder().decode(bytes),
        size,
        modified: modifiedIso(info),
      })
    })

  const previewFile = (target: string) =>
    Effect.gen(function* () {
      const { authorized, info } = yield* meta(target)
      if (getFileExt(authorized) !== "docx") {
        return yield* new WorkspaceIoError({
          operation: "files.preview",
          message: "Preview is only available for DOCX",
        })
      }
      const size = Number(info.size)
      if (size > DOCX_PREVIEW_MAX_BYTES) {
        return yield* new WorkspaceIoError({
          operation: "files.preview",
          message: "DOCX exceeds preview limit",
          tooLargeLimit: DOCX_PREVIEW_MAX_BYTES,
        })
      }
      const bytes = yield* io("files.preview.read", fs.readFile(authorized))
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const result = yield* Effect.tryPromise({
        try: () =>
          mammoth.convertToHtml({ arrayBuffer }, { externalFileAccess: false, convertImage: mammoth.images.dataUri }),
        catch: (cause) => new WorkspaceIoError({ operation: "files.preview.render", message: String(cause) }),
      })
      return FileContent.make({
        path: authorized,
        contentType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: wrapDocx(result.value, path.basename(authorized)),
        size,
        modified: modifiedIso(info),
      })
    })

  const watchFile = (target: string) =>
    Effect.gen(function* () {
      const { authorized } = yield* meta(target)
      const current = fileMeta(authorized).pipe(
        Effect.map((value) =>
          FileWatchEvent.make({
            _tag: "Changed",
            path: authorized,
            modified: value.modified,
            size: value.size,
          }),
        ),
      )
      const updates = fs.watch(authorized).pipe(
        Stream.mapEffect(() =>
          fileMeta(authorized).pipe(
            Effect.map((value) =>
              FileWatchEvent.make({
                _tag: "Changed",
                path: authorized,
                modified: value.modified,
                size: value.size,
              }),
            ),
            Effect.catch(() => Effect.succeed(FileWatchEvent.make({ _tag: "Removed", path: authorized }))),
          ),
        ),
        Stream.mapError((cause) => new WorkspaceIoError({ operation: "files.watch", message: String(cause) })),
      )
      return Stream.concat(Stream.fromEffect(current), updates)
    })

  const downloadFile = (target: string) =>
    Effect.gen(function* () {
      const { authorized } = yield* meta(target)
      return fs
        .stream(authorized)
        .pipe(Stream.mapError((cause) => new WorkspaceIoError({ operation: "files.download", message: String(cause) })))
    })

  const storeAttachments = (
    attachments: ReadonlyArray<{
      readonly name: string
      readonly mimeType: string
      readonly data: string
    }>,
  ) =>
    Effect.gen(function* () {
      const root = path.join(config.home, ".pi", "agent", "attachments")
      yield* io("attachments.mkdir", fs.makeDirectory(root, { recursive: true }))
      yield* policy.allowRoot(root)
      return yield* Effect.forEach(
        attachments,
        (attachment) =>
          Effect.gen(function* () {
            const decoded = Encoding.decodeBase64(attachment.data)
            if (Result.isFailure(decoded)) {
              return yield* new WorkspaceIoError({
                operation: "attachments.decode",
                message: "Invalid base64 attachment",
              })
            }
            if (decoded.success.byteLength > MAX_ATTACHMENT_BYTES) {
              return yield* new WorkspaceIoError({
                operation: "attachments.store",
                message: "Attachment exceeds 100 MB",
                tooLargeLimit: MAX_ATTACHMENT_BYTES,
              })
            }
            const digest = yield* crypto
              .digest("SHA-256", decoded.success)
              .pipe(
                Effect.mapError(
                  (cause) => new WorkspaceIoError({ operation: "attachments.hash", message: String(cause) }),
                ),
              )
            const directory = path.join(root, Encoding.encodeHex(digest))
            const uuid = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceIoError({
                    operation: "attachments.randomUUID",
                    message: String(cause),
                  }),
              ),
            )
            const fallbackName = `attachment-${uuid}`
            const name = path.basename(attachment.name).replace(/[\u0000-\u001f]/g, "_") || fallbackName
            const target = path.join(directory, name)
            yield* io("attachments.mkdir", fs.makeDirectory(directory, { recursive: true }))
            const exists = yield* io("attachments.exists", fs.exists(target))
            if (!exists) yield* io("attachments.write", fs.writeFile(target, decoded.success, { flag: "wx" }))
            return StoredAttachment.make({
              path: target,
              name,
              mimeType: attachment.mimeType || "application/octet-stream",
              size: decoded.success.byteLength,
            })
          }),
        { concurrency: 4 },
      )
    })

  void workspace
  return WorkspaceIo.of({
    validateCwd,
    pickCwd,
    defaultCwd,
    listFiles,
    readFile,
    fileMeta,
    previewFile,
    watchFile,
    downloadFile,
    storeAttachments,
  })
})

export const WorkspaceIoLive: Layer.Layer<
  WorkspaceIo,
  never,
  | AppConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileAccessPolicy
  | FileSystem.FileSystem
  | Path.Path
  | WorkspaceService
> = Layer.effect(WorkspaceIo, layerEffect)
