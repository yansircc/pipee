import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path, Result, Semaphore, Stream } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi"
import {
  Conflict,
  Forbidden,
  InvalidInput,
  NotFound,
  OperationFailed,
  PayloadTooLarge,
  PiWebApi,
  RequestSchemaErrors,
  SameOrigin,
  UnsupportedPlatform,
  type PluginsResponse,
  type PromptProgressEvent,
} from "./contract"
import { AppConfig, AppConfigLive } from "@/server/app-config"
import { FileAccessError, FileAccessPolicy, FileAccessPolicyLive } from "@/server/file-access-policy"
import { PackageIo, PackageIoError, PackageIoLive } from "@/server/package-io"
import { PiOperationBusyError, PiAgentAdapter, PiAgentAdapterLive, type PluginAction } from "@/server/pi-agent-adapter"
import { PiAdapterError, PiPromptIdempotencyError } from "@/server/pi-adapter-errors"
import { PiInteractionConflictError, PiInteractionResponseError } from "@/server/extension-ui-runtime"
import {
  RuntimeRegistryError,
  SessionRuntimeRegistry,
  SessionRuntimeRegistryLive,
  type RuntimeHandle,
} from "@/server/session-runtime-registry"
import { SessionRepository, SessionRepositoryError, SessionRepositoryLive } from "@/server/session-repository"
import { WorkspaceIo, WorkspaceIoError, WorkspaceIoLive } from "@/server/workspace-io"
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from "@/server/workspace-service"
import { activeSessionInfo, mergeSessionIndex } from "@/server/session-index"
import { PI_COMPANION_PACKAGE_NAMES, isLocalPackageSource } from "@/lib/plugin-package-settings"
import { WebSurfaceCatalog, WebSurfaceCatalogLive } from "@/server/web-surface-catalog"
import { webSurfaceAssetHandler } from "@/server/web-surface-assets"

const ok = { ok: true as const }

type PublicError =
  | InvalidInput
  | Forbidden
  | NotFound
  | Conflict
  | PayloadTooLarge
  | UnsupportedPlatform
  | OperationFailed

export const toPublicError = (error: unknown): PublicError => {
  if (error instanceof FileAccessError) {
    return new Forbidden({ message: "Path is outside the allowed workspace roots" })
  }
  if (error instanceof WorkspaceIoError) {
    if (error.forbiddenPath !== undefined)
      return new Forbidden({ message: "Path is outside the allowed workspace roots" })
    if (error.notFoundPath !== undefined) {
      return new NotFound({ resource: "path", id: error.notFoundPath, message: "Path was not found" })
    }
    if (error.tooLargeLimit !== undefined) {
      return new PayloadTooLarge({ limitBytes: error.tooLargeLimit, message: "Payload exceeds the allowed size" })
    }
    if (error.unsupportedPlatform !== undefined) {
      return new UnsupportedPlatform({
        platform: error.unsupportedPlatform,
        operation: error.operation,
        message: "Operation is unsupported on this platform",
      })
    }
    return new OperationFailed({ operation: error.operation, message: "Workspace operation failed" })
  }
  if (error instanceof WorkspaceError) {
    if (error.dirtyPath !== undefined) {
      return new Conflict({
        message: "Worktree contains uncommitted changes",
        detail: { _tag: "DirtyWorktree", path: error.dirtyPath },
      })
    }
    return new OperationFailed({ operation: error.operation, message: "Workspace operation failed" })
  }
  if (error instanceof SessionRepositoryError) {
    return error.notFoundId === undefined
      ? new OperationFailed({ operation: error.operation, message: "Session operation failed" })
      : new NotFound({ resource: "session", id: error.notFoundId, message: "Session was not found" })
  }
  if (error instanceof RuntimeRegistryError) {
    if (error.notFoundId !== undefined) {
      return new NotFound({ resource: "runtime", id: error.notFoundId, message: "Session runtime is not active" })
    }
    if (error.conflictOperation !== undefined) {
      return new Conflict({
        message: "Session already has an active operation",
        detail: { _tag: "AlreadyRunning", operation: error.conflictOperation },
      })
    }
    return new OperationFailed({ operation: error.operation, message: "Runtime operation failed" })
  }
  if (error instanceof PiPromptIdempotencyError) {
    return new Conflict({
      message:
        error.reason === "PayloadMismatch"
          ? "Idempotency key was reused with a different payload"
          : "Prior request may have executed; automatic replay is unsafe",
      detail: {
        _tag: "IdempotencyConflict",
        requestId: error.requestId,
        reason: error.reason,
      },
    })
  }
  if (error instanceof PiOperationBusyError) {
    return new Conflict({
      message: "Session already has an active operation",
      detail: { _tag: "AlreadyRunning", operation: error.kind },
    })
  }
  if (error instanceof PiInteractionConflictError) {
    return new Conflict({
      message: "Extension interaction is no longer pending",
      detail: { _tag: "PendingInteraction", interactionId: error.interactionId },
    })
  }
  if (error instanceof PiInteractionResponseError) {
    return new InvalidInput({ field: "answer", message: "Response type does not match the pending interaction" })
  }
  if (error instanceof PiAdapterError) {
    return new OperationFailed({
      operation: error.operation,
      message: error.operation.startsWith("auth.") ? "Authentication operation failed" : "Pi operation failed",
    })
  }
  if (error instanceof PackageIoError) {
    return new OperationFailed({ operation: error.operation, message: "Package operation failed" })
  }
  return new OperationFailed({ operation: "unknown", message: "Operation failed" })
}

const expose = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PublicError, R> =>
  Effect.mapError(effect, toPublicError)

const streamError = (operation: string) => (_error: unknown) =>
  new OperationFailed({ operation, message: "Stream operation failed" })

const SameOriginLive = Layer.succeed(SameOrigin, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const fetchSite = request.headers["sec-fetch-site"]
    if (fetchSite === "cross-site") {
      return yield* new Forbidden({ message: "Cross-site API requests are forbidden" })
    }
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return yield* httpEffect
    }
    const origin = request.headers.origin
    const host = request.headers["x-forwarded-host"] ?? request.headers.host
    if (origin === undefined || host === undefined) {
      return yield* new Forbidden({ message: "Mutation requires a same-origin request" })
    }
    const originHost = yield* Effect.try({
      try: () => new URL(origin).host,
      catch: () => new Forbidden({ message: "Mutation origin is invalid" }),
    })
    if (originHost !== host) return yield* new Forbidden({ message: "Mutation origin does not match the request host" })
    return yield* httpEffect
  }),
)

const RequestSchemaErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(RequestSchemaErrors, (error) =>
  Effect.fail(
    new InvalidInput({
      field: error.kind.toLowerCase(),
      message: `Invalid request ${error.kind.toLowerCase()}`,
    }),
  ),
)

const MetaLive = HttpApiBuilder.group(PiWebApi, "meta", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.succeed({
        status: "ok" as const,
        appVersion: __APP_VERSION__,
        piVersion: __PI_VERSION__,
      }),
    )
    .handle("version", () => Effect.succeed({ appVersion: __APP_VERSION__, piVersion: __PI_VERSION__ })),
)

const SessionsLive = HttpApiBuilder.group(PiWebApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const repository = yield* SessionRepository
    const registry = yield* SessionRuntimeRegistry
    const workspace = yield* WorkspaceService
    const workspaceIo = yield* WorkspaceIo
    const createSessionLock = yield* Semaphore.make(1)

    const projectActiveSession = (session: Parameters<typeof activeSessionInfo>[0]) =>
      workspace.resolveProject(session.cwd).pipe(
        Effect.map((project) =>
          activeSessionInfo(session, {
            projectRoot: project.projectRoot,
            ...(project.isWorktree && project.branch !== null ? { worktreeBranch: project.branch } : {}),
          }),
        ),
        Effect.catch(() => Effect.succeed(activeSessionInfo(session, { projectRoot: session.cwd }))),
      )

    const startExisting = (sessionId: string): Effect.Effect<RuntimeHandle, PublicError> =>
      Effect.gen(function* () {
        const current = yield* registry.activeOption(sessionId)
        if (current !== null) return current
        const snapshot = yield* expose(repository.snapshot(sessionId))
        return yield* expose(
          registry.start(sessionId, {
            sessionFile: snapshot.filePath,
            cwd: snapshot.info?.cwd ?? "",
          }),
        )
      })

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { persisted, active, runningSessionIds } = yield* Effect.all({
            persisted: expose(repository.list),
            active: registry.activeSessions,
            runningSessionIds: registry.runningIds,
          })
          const activeInfos = yield* Effect.forEach(active, projectActiveSession, { concurrency: 8 })
          return { sessions: mergeSessionIndex(persisted, activeInfos), runningSessionIds }
        }),
      )
      .handle("create", ({ payload }) =>
        createSessionLock.withPermits(1)(
          Effect.gen(function* () {
            const cwd = yield* expose(workspaceIo.validateCwd(payload.cwd))
            const configuration = {
              ...(payload.toolNames === undefined ? {} : { toolNames: payload.toolNames }),
              ...(payload.model === undefined ? {} : { model: payload.model }),
            }
            const candidates = (yield* registry.activeSessions)
              .filter((session) => session.cwd === cwd && session.isConversationEmpty)
              .toSorted((left, right) => right.created.localeCompare(left.created))
            for (const candidate of candidates) {
              const active = yield* registry.activeOption(candidate.sessionId)
              if (active !== null && (yield* active.runtime.matchesConfiguration(configuration))) {
                return yield* projectActiveSession(candidate)
              }
            }
            const requestId = yield* expose(registry.nextRunId)
            const handle = yield* expose(
              registry.start(`new:${requestId}`, {
                sessionFile: null,
                cwd,
                ...configuration,
              }),
            )
            return yield* projectActiveSession({
              sessionId: handle.sessionId,
              sessionFile: handle.runtime.sessionFile,
              cwd: handle.runtime.cwd,
              created: handle.runtime.created,
              firstMessage: yield* handle.runtime.firstMessage,
              isConversationEmpty: yield* handle.runtime.isConversationEmpty,
            })
          }),
        ),
      )
      .handle("snapshot", ({ params, query }) =>
        Effect.gen(function* () {
          const options = {
            deferThinking: query.deferThinking === "1" || query.deferThinking === "true",
            deferMedia: query.deferMedia === "1" || query.deferMedia === "true",
          }
          const active = yield* registry.activeOption(params.id)
          if (active === null) return yield* expose(repository.snapshot(params.id, options))

          const runtime = yield* expose(active.runtime.snapshot)
          const persisted = yield* expose(
            repository.snapshot(params.id, options).pipe(
              Effect.map((snapshot) => snapshot as typeof snapshot | null),
              Effect.catch((error) => (error.notFoundId === params.id ? Effect.succeed(null) : Effect.fail(error))),
            ),
          )
          if (persisted !== null) return { ...persisted, runtime }

          const info = yield* projectActiveSession({
            sessionId: active.sessionId,
            sessionFile: active.runtime.sessionFile,
            cwd: active.runtime.cwd,
            created: active.runtime.created,
            firstMessage: yield* active.runtime.firstMessage,
            isConversationEmpty: yield* active.runtime.isConversationEmpty,
          })

          return {
            sessionId: params.id,
            filePath: runtime.sessionFile,
            info,
            leafId: null,
            branchNodes: [],
            context: {
              messages: [],
              entryIds: [],
              promptRequests: [],
              thinkingLevel: runtime.thinkingLevel,
              model:
                runtime.model === undefined ? null : { provider: runtime.model.provider, modelId: runtime.model.id },
            },
            contextPage: { beforeEntryId: null, hasMoreBefore: false },
            runtime,
          }
        }),
      )
      .handle("rename", ({ params, payload }) =>
        Effect.gen(function* () {
          const name = payload.name.trim()
          if (!name) return yield* new InvalidInput({ field: "name", message: "Session name is required" })
          const active = yield* registry.activeOption(params.id)
          if (active === null) yield* expose(repository.rename(params.id, name))
          else yield* expose(active.runtime.setSessionName(name))
          return ok
        }),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const active = yield* registry.activeOption(params.id)
          yield* registry.close(params.id)
          yield* expose(
            repository
              .remove(params.id)
              .pipe(
                Effect.catch((error) =>
                  active !== null && error.notFoundId !== undefined ? Effect.void : Effect.fail(error),
                ),
              ),
          )
          return ok
        }),
      )
      .handle("context", ({ params, query }) =>
        expose(
          repository.context(params.id, {
            leafId: query.leafId,
            beforeEntryId: query.beforeEntryId,
            deferThinking: query.deferThinking === "1" || query.deferThinking === "true",
            deferMedia: query.deferMedia === "1" || query.deferMedia === "true",
          }),
        ),
      )
      .handle("thinking", ({ params, query }) =>
        expose(repository.thinking(params.id, query.entryId, query.blockIndex)).pipe(
          Effect.map((thinking) => ({ thinking })),
        ),
      )
      .handle("export", ({ params }) => expose(repository.exportHtml(params.id)))
      .handle("events", ({ params }) =>
        startExisting(params.id).pipe(
          Effect.flatMap(() => expose(registry.events(params.id))),
          Effect.map((events) => events.pipe(Stream.mapError(streamError("sessions.events")))),
        ),
      )
      .handle("runningEvents", () =>
        Effect.succeed(registry.runningEvents.pipe(Stream.mapError(streamError("sessions.runningEvents")))),
      )
  }),
)

const SessionActionsLive = HttpApiBuilder.group(PiWebApi, "sessionActions", (handlers) =>
  Effect.gen(function* () {
    const repository = yield* SessionRepository
    const registry = yield* SessionRuntimeRegistry

    const runtime = (sessionId: string) =>
      Effect.gen(function* () {
        const current = yield* registry.activeOption(sessionId)
        if (current !== null) return current
        const snapshot = yield* expose(repository.snapshot(sessionId))
        return yield* expose(
          registry.start(sessionId, {
            sessionFile: snapshot.filePath,
            cwd: snapshot.info?.cwd ?? "",
          }),
        )
      })

    return handlers
      .handle("prompt", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap(() => expose(registry.promptRequest(params.id, payload.requestId, payload))),
          Effect.map((request) => ({ requestId: payload.requestId, runId: request.runId })),
        ),
      )
      .handle("promptProgress", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap(() => expose(registry.promptRequest(params.id, payload.requestId, payload))),
          Effect.flatMap((request) =>
            expose(registry.events(params.id)).pipe(
              Effect.map((events) => {
                const tools: Stream.Stream<PromptProgressEvent, RuntimeRegistryError> = events.pipe(
                  Stream.filterMap((envelope) =>
                    envelope.event._tag === "ToolStarted" && envelope.event.runId === request.runId
                      ? Result.succeed({
                          _tag: "ToolStarted" as const,
                          runId: envelope.event.runId,
                          toolCallId: envelope.event.toolCallId,
                          toolName: envelope.event.toolName,
                        })
                      : Result.fail(undefined),
                  ),
                )
                const completed: Stream.Stream<PromptProgressEvent, RuntimeRegistryError | PiPromptIdempotencyError> =
                  Stream.fromEffect(request.completion).pipe(
                    Stream.map((result) => ({
                      _tag: "Completed" as const,
                      runId: result.runId,
                      text: result.text,
                    })),
                  )
                return tools.pipe(
                  Stream.merge(completed),
                  Stream.takeUntil((event) => event._tag === "Completed"),
                  Stream.mapError(streamError("sessionActions.promptProgress")),
                )
              }),
            ),
          ),
        ),
      )
      .handle("steer", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.steer(payload.message, payload.images))),
          Effect.as(ok),
        ),
      )
      .handle("followUp", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.followUp(payload.message, payload.images))),
          Effect.as(ok),
        ),
      )
      .handle("abort", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.abort)),
          Effect.as(ok),
        ),
      )
      .handle("fork", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap(() => expose(registry.forkSession(params.id, payload.entryId))),
          Effect.map(({ newSessionFile: _, ...result }) => result),
        ),
      )
      .handle("navigate", ({ params, payload }) =>
        runtime(params.id).pipe(Effect.flatMap((handle) => expose(handle.runtime.navigate(payload.targetId)))),
      )
      .handle("compact", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap(() => expose(registry.compact(params.id, payload.customInstructions))),
          Effect.map((runId) => ({ runId })),
        ),
      )
      .handle("abortCompaction", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.abortCompaction)),
          Effect.as(ok),
        ),
      )
      .handle("bash", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap(() =>
            expose(registry.bash(params.id, payload.id, payload.command, payload.excludeFromContext)),
          ),
          Effect.map((runId) => ({ runId })),
        ),
      )
      .handle("abortBash", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.abortBash)),
          Effect.as(ok),
        ),
      )
      .handle("setModel", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.setModel(payload.provider, payload.modelId))),
        ),
      )
      .handle("setThinking", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.setThinkingLevel(payload.level))),
          Effect.as(ok),
        ),
      )
      .handle("setTools", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.setTools(payload.toolNames))),
          Effect.as(ok),
        ),
      )
      .handle("tools", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.tools)),
          Effect.map((tools) => ({ tools })),
        ),
      )
      .handle("commands", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.commands)),
          Effect.map((commands) => ({ commands })),
        ),
      )
      .handle("stats", ({ params }) =>
        runtime(params.id).pipe(Effect.flatMap((handle) => expose(handle.runtime.stats))),
      )
      .handle("lastAssistant", ({ params }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => handle.runtime.lastAssistantText),
          Effect.map((text) => ({ text })),
        ),
      )
      .handle("setAutoCompaction", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.setAutoCompaction(payload.enabled))),
          Effect.as(ok),
        ),
      )
      .handle("setAutoRetry", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.setAutoRetry(payload.enabled))),
          Effect.as(ok),
        ),
      )
      .handle("clearQueue", ({ params }) =>
        runtime(params.id).pipe(Effect.flatMap((handle) => expose(handle.runtime.clearQueue))),
      )
      .handle("reload", ({ params }) => expose(registry.restart(params.id)).pipe(Effect.as(ok)))
      .handle("slashCommand", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) => expose(handle.runtime.invokeSlashCommand(payload.name, payload.args))),
          Effect.as(ok),
        ),
      )
      .handle("resolveInteraction", ({ params, payload }) =>
        runtime(params.id).pipe(
          Effect.flatMap((handle) =>
            handle.identity.runtimeId === params.runtimeId
              ? expose(handle.runtime.resolveInteraction(params.interactionId, payload))
              : Effect.fail(new Conflict({ message: "Session runtime changed before interaction resolution" })),
          ),
          Effect.as(ok),
        ),
      )
  }),
)

const WorkspaceLive = HttpApiBuilder.group(PiWebApi, "workspace", (handlers) =>
  Effect.gen(function* () {
    const io = yield* WorkspaceIo
    const workspace = yield* WorkspaceService
    const policy = yield* FileAccessPolicy
    return handlers
      .handle("home", () => Effect.succeed({ home: workspace.home }))
      .handle("validateCwd", ({ payload }) =>
        Effect.gen(function* () {
          const cwd = yield* expose(io.validateCwd(payload.cwd))
          const project = yield* expose(workspace.resolveProject(cwd))
          return { cwd, project }
        }),
      )
      .handle("pickCwd", () => expose(io.pickCwd).pipe(Effect.map((cwd) => ({ cwd }))))
      .handle("defaultCwd", () => expose(io.defaultCwd).pipe(Effect.map((cwd) => ({ cwd }))))
      .handle("fileIndex", ({ query }) => expose(io.listFiles(query.root, query.query, query.deep === "1")))
      .handle("readFile", ({ query }) => expose(io.readFile(query.path)))
      .handle("fileMeta", ({ query }) => expose(io.fileMeta(query.path)))
      .handle("previewFile", ({ query }) => expose(io.previewFile(query.path)))
      .handle("watchFile", ({ query }) =>
        expose(io.watchFile(query.path)).pipe(
          Effect.map((stream) => stream.pipe(Stream.mapError(streamError("files.watch")))),
        ),
      )
      .handle("downloadFile", ({ query }) =>
        expose(io.downloadFile(query.path)).pipe(
          Effect.map((stream) => stream.pipe(Stream.mapError(streamError("files.download")))),
        ),
      )
      .handle("attachments", ({ payload }) =>
        expose(io.storeAttachments(payload.attachments)).pipe(Effect.map((attachments) => ({ attachments }))),
      )
      .handle("worktrees", ({ query }) =>
        Effect.gen(function* () {
          const cwd = yield* expose(policy.assertExisting(query.cwd))
          const project = yield* expose(workspace.resolveProject(cwd))
          const isGit = project.isTopLevel || project.isWorktree || project.branch !== null
          const worktrees = isGit ? yield* expose(workspace.listWorktrees(cwd)) : []
          return { worktrees, project }
        }),
      )
      .handle("createWorktree", ({ payload }) =>
        Effect.gen(function* () {
          const cwd = yield* expose(policy.assertExisting(payload.cwd))
          const result = yield* expose(workspace.createWorktree(cwd, payload.branch))
          yield* policy.allowRoot(result.path)
          return result
        }),
      )
      .handle("removeWorktree", ({ payload }) =>
        Effect.gen(function* () {
          const cwd = yield* expose(policy.assertExisting(payload.cwd))
          const target = yield* expose(policy.assertExisting(payload.path))
          yield* expose(workspace.removeWorktree(cwd, target, payload.force))
          return ok
        }),
      )
  }),
)

const ModelsLive = HttpApiBuilder.group(PiWebApi, "models", (handlers) =>
  Effect.gen(function* () {
    const adapter = yield* PiAgentAdapter
    const workspace = yield* WorkspaceIo
    return handlers
      .handle("catalog", ({ query }) =>
        workspace.validateCwd(query.cwd).pipe(
          Effect.flatMap((cwd) => adapter.modelCatalog(cwd)),
          expose,
        ),
      )
      .handle("config", () => expose(adapter.readModelsConfig))
      .handle("validateConfig", ({ payload }) => expose(adapter.validateModelsConfig(payload)))
      .handle("saveConfig", ({ payload }) => expose(adapter.saveModelsConfig(payload)).pipe(Effect.as(ok)))
      .handle("testConfig", ({ payload }) =>
        expose(adapter.testModelConfig(payload.providerName, payload.provider, payload.model)),
      )
  }),
)

const AuthLive = HttpApiBuilder.group(PiWebApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const adapter = yield* PiAgentAdapter
    return handlers
      .handle("oauthProviders", () => expose(adapter.oauthProviders).pipe(Effect.map((providers) => ({ providers }))))
      .handle("apiKeyProviders", () => expose(adapter.apiKeyProviders).pipe(Effect.map((providers) => ({ providers }))))
      .handle("apiKeyStatus", ({ params }) => expose(adapter.apiKeyStatus(params.provider)))
      .handle("setApiKey", ({ params, payload }) => {
        const apiKey = payload.apiKey.trim()
        return apiKey
          ? expose(adapter.setApiKey(params.provider, apiKey)).pipe(Effect.as(ok))
          : Effect.fail(new InvalidInput({ field: "apiKey", message: "API key is required" }))
      })
      .handle("removeApiKey", ({ params }) => expose(adapter.removeApiKey(params.provider)).pipe(Effect.as(ok)))
      .handle("oauthEvents", ({ params }) =>
        expose(adapter.oauthEvents(params.provider)).pipe(
          Effect.map((events) => events.pipe(Stream.mapError(streamError("auth.oauth")))),
        ),
      )
      .handle("submitOAuthInput", ({ params, payload }) =>
        expose(adapter.submitOAuthInput(params.provider, payload.token, payload.code)).pipe(Effect.as(ok)),
      )
      .handle("logout", ({ params }) => expose(adapter.logout(params.provider)).pipe(Effect.as(ok)))
  }),
)

const PackagesLive = HttpApiBuilder.group(PiWebApi, "packages", (handlers) =>
  Effect.gen(function* () {
    const adapter = yield* PiAgentAdapter
    const registry = yield* SessionRuntimeRegistry
    const repository = yield* SessionRepository
    const config = yield* AppConfig
    const packageIo = yield* PackageIo
    const path = yield* Path.Path
    const policy = yield* FileAccessPolicy
    const workspace = yield* WorkspaceIo
    const globalProjection = (projection: PluginsResponse) => {
      const packages = projection.packages.filter((pkg) => pkg.scope === "global")
      return {
        packages,
        totals: packages.reduce(
          (totals, pkg) => ({
            extensions: totals.extensions + pkg.counts.extensions,
            skills: totals.skills + pkg.counts.skills,
            prompts: totals.prompts + pkg.counts.prompts,
            themes: totals.themes + pkg.counts.themes,
          }),
          { extensions: 0, skills: 0, prompts: 0, themes: 0 },
        ),
        diagnostics: projection.diagnostics,
      }
    }
    const readGlobalPlugins = adapter.plugins(config.home).pipe(Effect.map(globalProjection))
    const readPluginOverview = Effect.gen(function* () {
      const global = yield* readGlobalPlugins
      const sessions = yield* repository.list
      const representativeByCwd = new Map<string, (typeof sessions)[number]>()
      for (const session of sessions) {
        const current = representativeByCwd.get(session.cwd)
        if (current === undefined || session.modified > current.modified) representativeByCwd.set(session.cwd, session)
      }
      const projects = yield* Effect.forEach(
        representativeByCwd.values(),
        (session) =>
          adapter.plugins(session.cwd).pipe(
            Effect.map((projection) => ({
              packages: projection.packages
                .filter((pkg) => pkg.scope === "project")
                .map((pkg) => ({ ...pkg, ownerCwd: session.cwd })),
              diagnostics: projection.diagnostics,
            })),
          ),
        { concurrency: 8 },
      )
      const packages = [...global.packages, ...projects.flatMap((projection) => projection.packages)].sort(
        (left, right) =>
          (left.packageName ?? left.source).localeCompare(right.packageName ?? right.source) ||
          left.scope.localeCompare(right.scope) ||
          (left.ownerCwd ?? "").localeCompare(right.ownerCwd ?? ""),
      )
      const diagnostics = [
        ...new Map(
          [...global.diagnostics, ...projects.flatMap((projection) => projection.diagnostics)].map((diagnostic) => [
            `${diagnostic.type}\0${diagnostic.source ?? ""}\0${diagnostic.path ?? ""}\0${diagnostic.message}`,
            diagnostic,
          ]),
        ).values(),
      ]
      return {
        packages,
        totals: packages.reduce(
          (totals, pkg) => ({
            extensions: totals.extensions + pkg.counts.extensions,
            skills: totals.skills + pkg.counts.skills,
            prompts: totals.prompts + pkg.counts.prompts,
            themes: totals.themes + pkg.counts.themes,
          }),
          { extensions: 0, skills: 0, prompts: 0, themes: 0 },
        ),
        diagnostics,
      }
    })
    const readGlobalChromePlugin = readGlobalPlugins.pipe(
      Effect.map(
        (projection) =>
          projection.packages.find((pkg) => pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome) ?? null,
      ),
    )
    const admitLocalPackageInstall = (cwd: string, action: PluginAction, source: string | undefined) => {
      const normalized = source?.trim()
      if (action !== "install" || normalized === undefined || !isLocalPackageSource(normalized)) return Effect.void
      const target =
        normalized === "~"
          ? config.home
          : normalized.startsWith("~/")
            ? path.join(config.home, normalized.slice(2))
            : path.resolve(cwd, normalized)
      return policy.admitExistingRoot(target)
    }
    return handlers
      .handle("pluginOverview", () => expose(readPluginOverview))
      .handle("globalPlugins", () => expose(readGlobalPlugins))
      .handle("globalChromePlugin", () => expose(readGlobalChromePlugin).pipe(Effect.map((pkg) => ({ package: pkg }))))
      .handle("downloadChromeExtension", () =>
        expose(readGlobalChromePlugin).pipe(
          Effect.flatMap((pkg) =>
            pkg?.chromeExtensionDirectory === undefined
              ? Effect.fail(
                  new NotFound({
                    resource: "package",
                    id: PI_COMPANION_PACKAGE_NAMES.chrome,
                    message: "The installed pi-chrome package has no browser extension artifact",
                  }),
                )
              : expose(packageIo.archiveDirectory(pkg.chromeExtensionDirectory)),
          ),
          Effect.map(Stream.make),
        ),
      )
      .handle("plugins", ({ query }) =>
        workspace.validateCwd(query.cwd).pipe(
          Effect.flatMap((cwd) => adapter.plugins(cwd)),
          expose,
        ),
      )
      .handle("pluginAction", ({ payload }) =>
        Effect.gen(function* () {
          const cwd =
            payload.cwd !== undefined
              ? yield* expose(workspace.validateCwd(payload.cwd))
              : payload.scope === "global"
                ? config.home
                : yield* new InvalidInput({ field: "cwd", message: "Project plugin actions require a workspace" })
          yield* expose(admitLocalPackageInstall(cwd, payload.action, payload.source))
          const projection = yield* expose(adapter.pluginAction(cwd, payload.action, payload.source, payload.scope))
          yield* expose(registry.invalidatePackageChanges)
          return payload.cwd === undefined ? globalProjection(projection) : projection
        }),
      )
      .handle("skills", ({ query }) =>
        workspace.validateCwd(query.cwd).pipe(
          Effect.flatMap((cwd) => adapter.skills(cwd)),
          expose,
        ),
      )
      .handle("toggleSkill", ({ payload }) =>
        Effect.gen(function* () {
          const cwd = yield* expose(workspace.validateCwd(payload.cwd))
          const projection = yield* expose(adapter.skills(cwd))
          const skill = projection.skills.find((candidate) => candidate.filePath === payload.filePath)
          if (skill === undefined) {
            return yield* new Forbidden({ message: "Skill is not owned by the selected workspace" })
          }
          yield* expose(adapter.toggleSkill(skill.filePath, payload.disableModelInvocation))
          return ok
        }),
      )
      .handle("searchSkills", ({ payload }) => {
        const query = payload.query.trim()
        if (!query) return Effect.fail(new InvalidInput({ field: "query", message: "Search query is required" }))
        const limit = Math.min(50, Math.max(1, Math.floor(payload.limit ?? 50)))
        return expose(packageIo.searchSkills(query, limit)).pipe(Effect.map((results) => ({ results })))
      })
      .handle("installSkill", ({ payload }) => {
        const packageName = payload.package.trim()
        if (!packageName) return Effect.fail(new InvalidInput({ field: "package", message: "Package is required" }))
        const cwd = payload.scope === "project" ? workspace.validateCwd(payload.cwd) : Effect.succeed(undefined)
        return expose(cwd).pipe(
          Effect.flatMap((canonicalCwd) => expose(packageIo.installSkill(packageName, payload.scope, canonicalCwd))),
          Effect.map((output) => ({ output })),
        )
      })
  }),
)

const WebSurfacesLive = HttpApiBuilder.group(PiWebApi, "webSurfaces", (handlers) =>
  Effect.gen(function* () {
    const catalog = yield* WebSurfaceCatalog
    const registry = yield* SessionRuntimeRegistry
    return handlers
      .handle("catalog", ({ params }) => expose(catalog.read(params.id)).pipe(Effect.map((result) => result.public)))
      .handle("dispatch", ({ params, payload }) =>
        Effect.gen(function* () {
          const admitted = yield* expose(catalog.read(params.id))
          const surface = admitted.admitted.get(params.surfaceId)
          if (surface === undefined || surface.candidate.candidateHash !== params.candidateHash) {
            return yield* new NotFound({
              resource: "web-surface",
              id: params.surfaceId,
              message: "Web surface candidate is not active",
            })
          }
          const handle = yield* expose(registry.active(params.id))
          if (handle.identity.runtimeId !== params.runtimeId) {
            return yield* new Conflict({ message: "Session runtime changed before web surface action" })
          }
          return yield* handle.runtime.dispatchWebSurface(
            surface.candidate.packageName,
            surface.candidate.candidateHash,
            payload,
          )
        }),
      )
  }),
)

const FoundationLive = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpServer.layerHttpServices,
  NodeHttpClient.layerUndici,
  AppConfigLive,
)

const AdapterAndWorkspaceLive = Layer.merge(PiAgentAdapterLive, WorkspaceServiceLive).pipe(
  Layer.provideMerge(FoundationLive),
)

const DomainLive = Layer.mergeAll(SessionRepositoryLive, SessionRuntimeRegistryLive, FileAccessPolicyLive).pipe(
  Layer.provideMerge(AdapterAndWorkspaceLive),
)

const ServicesLive = Layer.mergeAll(WorkspaceIoLive, PackageIoLive, WebSurfaceCatalogLive).pipe(
  Layer.provideMerge(DomainLive),
)

const HandlersLive = Layer.mergeAll(
  MetaLive,
  SessionsLive,
  SessionActionsLive,
  WorkspaceLive,
  ModelsLive,
  AuthLive,
  PackagesLive,
  WebSurfacesLive,
).pipe(Layer.provide(Layer.mergeAll(ServicesLive, SameOriginLive, RequestSchemaErrorsLive)))

const ApiLive = HttpApiBuilder.layer(PiWebApi).pipe(Layer.provide(HandlersLive), Layer.provide(FoundationLive))

const registerHttpRoutes = HttpRouter.use
const WebSurfaceAssetRoutesLive = registerHttpRoutes((router) =>
  Effect.gen(function* () {
    const catalog = yield* WebSurfaceCatalog
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* router.add("GET", "/extension-assets/*", (request) => webSurfaceAssetHandler(catalog, fs, path, request))
  }),
).pipe(Layer.provide(ServicesLive))

const WebAppLive = Layer.merge(ApiLive, WebSurfaceAssetRoutesLive)

const webHandler = HttpRouter.toWebHandler(WebAppLive, { disableLogger: true })

export const handleApiRequest = webHandler.handler
export const disposeApi = webHandler.dispose
