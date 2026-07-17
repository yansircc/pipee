import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import {
  AgentMessage,
  SessionBranchNode,
  SessionContext,
  SessionContextPage,
  SessionInfo,
  SessionSnapshot,
  type SessionEntry,
  type SessionInfo as SessionInfoValue,
} from "@/api/contract"
import { PiAgentAdapter, type PiSessionDocument } from "./pi-agent-adapter"
import { WorkspaceService } from "./workspace-service"
import { projectPromptRequestReceipts } from "./prompt-request"

export class SessionRepositoryError extends Data.TaggedError("SessionRepositoryError")<{
  readonly operation: string
  readonly message: string
  readonly notFoundId?: string
}> {}

export interface SessionReadOptions {
  readonly leafId?: string | null
  readonly beforeEntryId?: string
  readonly limit?: number
  readonly deferThinking?: boolean
  readonly deferMedia?: boolean
}

export class SessionRepository extends Context.Service<
  SessionRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<SessionInfoValue>, SessionRepositoryError>
    readonly resolvePath: (sessionId: string) => Effect.Effect<string, SessionRepositoryError>
    readonly snapshot: (
      sessionId: string,
      options?: SessionReadOptions,
    ) => Effect.Effect<typeof SessionSnapshot.Type, SessionRepositoryError>
    readonly context: (
      sessionId: string,
      options?: SessionReadOptions,
    ) => Effect.Effect<typeof SessionContextPage.Type, SessionRepositoryError>
    readonly thinking: (
      sessionId: string,
      entryId: string,
      blockIndex: number,
    ) => Effect.Effect<string, SessionRepositoryError>
    readonly rename: (sessionId: string, name: string) => Effect.Effect<void, SessionRepositoryError>
    readonly remove: (sessionId: string) => Effect.Effect<void, SessionRepositoryError>
    readonly exportHtml: (sessionId: string) => Effect.Effect<Stream.Stream<Uint8Array>, SessionRepositoryError>
  }
>()("pi-web/server/SessionRepository") {}

const branchLabel = (entry: SessionEntry): string => {
  if (entry.type !== "message") return entry.type
  const message = entry.message
  const content: unknown = "content" in message ? message.content : ""
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block) =>
              typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block
                ? [String(block.text)]
                : [],
            )
            .join(" ")
        : ""
  if (text) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  return message.role === "assistant" ? "[assistant]" : entry.type
}

export const projectSessionBranches = (
  entries: ReadonlyArray<SessionEntry>,
  activeLeafId: string | null = entries.at(-1)?.id ?? null,
): ReadonlyArray<typeof SessionBranchNode.Type> => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const childCounts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.parentId !== null) childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1)
  }
  const kept = new Set(
    entries
      .filter((entry) => entry.parentId === null || (childCounts.get(entry.id) ?? 0) !== 1)
      .map((entry) => entry.id),
  )
  return entries.flatMap((entry) => {
    if (!kept.has(entry.id)) return []
    let compressedCount = 0
    let active = entry.id === activeLeafId
    const visited = new Set<string>([entry.id])
    let parentId = entry.parentId
    while (parentId !== null && !kept.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId)
      compressedCount += 1
      active ||= parentId === activeLeafId
      parentId = byId.get(parentId)?.parentId ?? null
    }
    if (parentId !== null && visited.has(parentId)) parentId = null
    return [
      SessionBranchNode.make({
        entryId: entry.id,
        parentNodeId: parentId,
        timestamp: entry.timestamp,
        kind: entry.type,
        ...(entry.type === "message" ? { role: entry.message.role } : {}),
        label: branchLabel(entry),
        compressedCount,
        active,
      }),
    ]
  })
}

const parseTimestamp = (value: string): number | undefined => {
  const parsed = globalThis.Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const base64Bytes = (block: unknown): { readonly bytes: number; readonly mime?: string } | null => {
  if (typeof block !== "object" || block === null || (block as { readonly type?: unknown }).type !== "image")
    return null
  const value = block as {
    readonly data?: unknown
    readonly mimeType?: unknown
    readonly source?: { readonly type?: unknown; readonly data?: unknown; readonly media_type?: unknown }
  }
  const data =
    typeof value.data === "string"
      ? value.data
      : value.source?.type === "base64" && typeof value.source.data === "string"
        ? value.source.data
        : undefined
  if (data === undefined) return null
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  const mime =
    typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.source?.media_type === "string"
        ? value.source.media_type
        : undefined
  return {
    bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding),
    ...(mime === undefined ? {} : { mime }),
  }
}

const omitMedia = (message: typeof AgentMessage.Type): typeof AgentMessage.Type => {
  if (message.role !== "toolResult") return message
  let omitted = 0
  let bytes = 0
  const mimes = new Set<string>()
  const content = message.content.filter((block) => {
    const image = base64Bytes(block)
    if (image === null) return true
    omitted += 1
    bytes += image.bytes
    if (image.mime !== undefined) mimes.add(image.mime)
    return false
  })
  if (omitted === 0) return message
  const mimeText = mimes.size === 0 ? "" : `: ${[...mimes].join(", ")}`
  return {
    ...message,
    content: [
      ...content,
      {
        type: "text",
        text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
      },
    ],
  }
}

const entryMessage = (entry: SessionEntry, options: SessionReadOptions): typeof AgentMessage.Type | null => {
  switch (entry.type) {
    case "message": {
      const message = options.deferMedia ? omitMedia(entry.message) : entry.message
      if (!options.deferThinking || message.role !== "assistant") return message
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "thinking" && block.thinking.trim() ? { ...block, thinking: "", deferred: true } : block,
        ),
      }
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseTimestamp(entry.timestamp),
      }
    case "branch_summary":
      return entry.summary
        ? {
            role: "user",
            content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
            timestamp: parseTimestamp(entry.timestamp),
          }
        : null
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseTimestamp(entry.timestamp),
      }
    default:
      return null
  }
}

export const buildSessionContext = (
  document: PiSessionDocument,
  options: SessionReadOptions,
): typeof SessionContext.Type => buildSessionContextPage(document, options).context

const sessionPath = (document: PiSessionDocument, leafId: string | null | undefined): ReadonlyArray<SessionEntry> => {
  if (leafId === null) return []
  const byId = new Map(document.entries.map((entry) => [entry.id, entry]))
  let leaf = leafId === undefined ? undefined : byId.get(leafId)
  if (leaf === undefined) leaf = document.entries[document.entries.length - 1]
  const path: Array<SessionEntry> = []
  const visited = new Set<string>()
  while (leaf !== undefined && !visited.has(leaf.id)) {
    visited.add(leaf.id)
    path.push(leaf)
    leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId)
  }
  path.reverse()
  return path
}

export const buildSessionContextPage = (
  document: PiSessionDocument,
  options: SessionReadOptions,
): typeof SessionContextPage.Type => {
  if (options.leafId === null) {
    return {
      context: {
        messages: [],
        entryIds: [],
        promptRequests: [],
        thinkingLevel: document.thinkingLevel,
        model: document.model,
      },
      beforeEntryId: null,
      hasMoreBefore: false,
    }
  }
  return buildContextPage(sessionPath(document, options.leafId), document, options)
}

const DEFAULT_CONTEXT_PAGE_SIZE = 200

const buildContextPage = (
  path: ReadonlyArray<SessionEntry>,
  document: PiSessionDocument,
  options: SessionReadOptions,
): typeof SessionContextPage.Type => {
  const visible = path.flatMap((entry) => {
    const message = entryMessage(entry, options)
    return message === null ? [] : [{ entry, message }]
  })
  const cursorIndex =
    options.beforeEntryId === undefined
      ? visible.length
      : visible.findIndex(({ entry }) => entry.id === options.beforeEntryId)
  const end = cursorIndex < 0 ? visible.length : cursorIndex
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_CONTEXT_PAGE_SIZE, DEFAULT_CONTEXT_PAGE_SIZE))
  const start = Math.max(0, end - limit)
  const page = visible.slice(start, end)
  const messages: Array<typeof AgentMessage.Type> = []
  const entryIds: Array<string> = []
  for (const { entry, message } of page) {
    messages.push(message)
    entryIds.push(entry.id)
  }
  return {
    context: {
      messages,
      entryIds,
      promptRequests: projectPromptRequestReceipts(path),
      thinkingLevel: document.thinkingLevel,
      model: document.model,
    },
    beforeEntryId: start > 0 ? (page[0]?.entry.id ?? null) : null,
    hasMoreBefore: start > 0,
  }
}

const layerEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const adapter = yield* PiAgentAdapter
  const workspace = yield* WorkspaceService

  const fromAdapter = <A>(operation: string, effect: Effect.Effect<A, { readonly message: string }>) =>
    effect.pipe(Effect.mapError((cause) => new SessionRepositoryError({ operation, message: cause.message })))
  const fromFileSystem = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError((cause) => new SessionRepositoryError({ operation, message: String(cause) })))

  const list = Effect.gen(function* () {
    const sessions = yield* fromAdapter("sessions.list", adapter.listSessions)
    const pathToId = new Map(sessions.map((session) => [path.normalize(session.path), session.id]))
    const projects = yield* Effect.forEach(
      [...new Set(sessions.map((session) => session.cwd).filter(Boolean))],
      (cwd) =>
        workspace.resolveProject(cwd).pipe(
          Effect.map((project) => [cwd, project] as const),
          Effect.catch(() =>
            Effect.succeed([
              cwd,
              {
                projectRoot: cwd,
                branch: null,
                isWorktree: false,
                isTopLevel: false,
              },
            ] as const),
          ),
        ),
      { concurrency: 8 },
    )
    const projectByCwd = new Map(projects)
    return sessions.map((session) => {
      const project = projectByCwd.get(session.cwd)
      return SessionInfo.make({
        path: session.path,
        id: session.id,
        cwd: session.cwd,
        ...(session.name === undefined ? {} : { name: session.name }),
        created: session.created,
        modified: session.modified,
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        ...(session.parentSessionPath === undefined
          ? {}
          : { parentSessionId: pathToId.get(path.normalize(session.parentSessionPath)) }),
        projectRoot: project?.projectRoot ?? session.cwd,
        ...(project?.isWorktree && project.branch !== null ? { worktreeBranch: project.branch } : {}),
      })
    })
  })

  const resolveSession = (sessionId: string) =>
    Effect.gen(function* () {
      const sessions = yield* list
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (session === undefined) {
        return yield* new SessionRepositoryError({
          operation: "session.resolve",
          message: "Session not found",
          notFoundId: sessionId,
        })
      }
      return session
    })

  const resolvePath = (sessionId: string) => Effect.map(resolveSession(sessionId), (session) => session.path)

  const loadSession = (sessionId: string) =>
    Effect.gen(function* () {
      const info = yield* resolveSession(sessionId)
      const document = yield* fromAdapter("session.read", adapter.readSession(info.path))
      return { document, info } as const
    })

  const loadDocument = (sessionId: string) => Effect.map(loadSession(sessionId), ({ document }) => document)

  const context = (sessionId: string, options: SessionReadOptions = {}) =>
    Effect.map(loadDocument(sessionId), (document) => buildSessionContextPage(document, options))

  const snapshot = (sessionId: string, options: SessionReadOptions = {}) =>
    Effect.gen(function* () {
      const { document, info } = yield* loadSession(sessionId)
      const page = buildSessionContextPage(document, { ...options, leafId: options.leafId ?? document.leafId })
      const sessionContext = page.context
      return SessionSnapshot.make({
        sessionId,
        filePath: document.filePath,
        info,
        leafId: document.leafId,
        branchNodes: projectSessionBranches(document.entries, document.leafId),
        context: sessionContext,
        contextPage: { beforeEntryId: page.beforeEntryId, hasMoreBefore: page.hasMoreBefore },
        runtime: null,
      })
    })

  const thinking = (sessionId: string, entryId: string, blockIndex: number) =>
    Effect.gen(function* () {
      const document = yield* loadDocument(sessionId)
      const entry = document.entries.find((candidate) => candidate.id === entryId)
      if (entry?.type !== "message" || entry.message.role !== "assistant") {
        return yield* new SessionRepositoryError({
          operation: "session.thinking",
          message: "Assistant message not found",
          notFoundId: entryId,
        })
      }
      const block = entry.message.content[blockIndex]
      if (block?.type !== "thinking") {
        return yield* new SessionRepositoryError({
          operation: "session.thinking",
          message: "Thinking block not found",
          notFoundId: `${entryId}:${blockIndex}`,
        })
      }
      return block.thinking
    })

  const rename = (sessionId: string, name: string) =>
    Effect.gen(function* () {
      const filePath = yield* resolvePath(sessionId)
      yield* fromAdapter("session.rename", adapter.appendSessionName(filePath, name.trim()))
    })

  const Header = Schema.Struct({
    type: Schema.Literal("session"),
    version: Schema.optionalKey(Schema.Number),
    id: Schema.String,
    timestamp: Schema.String,
    cwd: Schema.String,
    parentSession: Schema.optionalKey(Schema.String),
  })
  const HeaderJson = Schema.fromJsonString(Header)

  const remove = (sessionId: string) =>
    Effect.gen(function* () {
      const filePath = yield* resolvePath(sessionId)
      const content = yield* fromFileSystem("session.readForDelete", fs.readFileString(filePath))
      const firstLineEnd = content.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd)
      const header = yield* Schema.decodeUnknownEffect(HeaderJson)(firstLine).pipe(
        Effect.mapError((cause) => new SessionRepositoryError({ operation: "session.header", message: String(cause) })),
      )
      const siblings = yield* fromFileSystem("session.siblings", fs.readDirectory(path.dirname(filePath)))
      yield* Effect.forEach(
        siblings,
        (name) =>
          Effect.gen(function* () {
            if (!name.endsWith(".jsonl")) return
            const childPath = path.join(path.dirname(filePath), name)
            if (childPath === filePath) return
            const child = yield* fs.readFileString(childPath).pipe(Effect.option)
            if (Option.isNone(child)) return
            const end = child.value.indexOf("\n")
            const line = end === -1 ? child.value : child.value.slice(0, end)
            const decoded = yield* Schema.decodeUnknownEffect(HeaderJson)(line).pipe(Effect.option)
            if (Option.isNone(decoded) || decoded.value.parentSession !== filePath) return
            const next = {
              ...decoded.value,
              ...(header.parentSession === undefined
                ? { parentSession: undefined }
                : { parentSession: header.parentSession }),
            }
            const encoded = yield* Schema.encodeUnknownEffect(HeaderJson)(next).pipe(
              Effect.mapError(
                (cause) => new SessionRepositoryError({ operation: "session.header.encode", message: String(cause) }),
              ),
            )
            yield* fromFileSystem(
              "session.reparent",
              fs.writeFileString(childPath, end === -1 ? encoded : `${encoded}${child.value.slice(end)}`),
            )
          }),
        { concurrency: 8 },
      )
      yield* fromFileSystem("session.remove", fs.remove(filePath))
    })

  const exportHtml = (sessionId: string) =>
    Effect.gen(function* () {
      const filePath = yield* resolvePath(sessionId)
      const html = yield* fromAdapter("session.export", adapter.exportHtml(filePath))
      return Stream.make(html).pipe(Stream.encodeText)
    })

  return SessionRepository.of({
    list,
    resolvePath,
    snapshot,
    context,
    thinking,
    rename,
    remove,
    exportHtml,
  })
})

export const SessionRepositoryLive: Layer.Layer<
  SessionRepository,
  never,
  FileSystem.FileSystem | Path.Path | PiAgentAdapter | WorkspaceService
> = Layer.effect(SessionRepository, layerEffect)
