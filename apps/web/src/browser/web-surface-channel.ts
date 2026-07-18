import { Cause, Data, Deferred, Effect, FiberSet, Option, Schema, Stream } from "effect"
import {
  WEB_SURFACE_CHANNEL_CONTRACT,
  WebSurfaceClientMessage,
  type WebSurfaceCatalogItem,
  type WebSurfaceHostMessage,
  type WebSurfaceRuntimeIdentity,
} from "@pi-suite/companion-contracts/web-surface"
import { PiWebHttpClient, withApi } from "./http-api-client"

export class WebSurfaceFrameError extends Data.TaggedError("WebSurfaceFrameError")<{ readonly message: string }> {}

export interface WebSurfaceChannelCallbacks {
  readonly navigate: (path: string) => void
  readonly notify: (message: string, level: "info" | "warning" | "error") => void
  readonly confirm: (title: string, message: string) => Promise<boolean>
  readonly state: (state: "connecting" | "ready" | "failed", message?: string) => void
}

const decodeClientMessage = Schema.decodeUnknownOption(WebSurfaceClientMessage)
const sameRuntime = (left: WebSurfaceRuntimeIdentity, right: WebSurfaceRuntimeIdentity) =>
  left.registryId === right.registryId && left.runtimeEpoch === right.runtimeEpoch && left.runtimeId === right.runtimeId

export const connectWebSurface = (
  iframe: HTMLIFrameElement,
  sessionId: string,
  catalog: WebSurfaceCatalogItem,
  callbacks: WebSurfaceChannelCallbacks,
) =>
  Effect.gen(function* () {
    callbacks.state("connecting")
    const client = yield* PiWebHttpClient
    const channel = new MessageChannel()
    const port = channel.port1
    const ready = yield* Deferred.make<void>()
    const fibers = yield* FiberSet.make()
    const runFork = yield* FiberSet.runtime(fibers)()
    const requests = new Set<string>()
    let runtime: WebSurfaceRuntimeIdentity | null = null
    let revision = -1
    let initialized = false

    const post = (message: WebSurfaceHostMessage) => port.postMessage(message)

    port.onmessage = (event) => {
      const decoded = decodeClientMessage(event.data)
      if (Option.isNone(decoded)) {
        callbacks.state("failed", "拓展发送了无效消息")
        return
      }
      const message = decoded.value
      if (message._tag === "ready") {
        runFork(Deferred.succeed(ready, undefined))
        return
      }
      if (message._tag === "navigate") {
        if (!URL.canParse(message.path, globalThis.location.origin)) return
        const target = new URL(message.path, globalThis.location.origin)
        if (target.origin !== globalThis.location.origin || !target.pathname.startsWith("/")) return
        callbacks.navigate(`${target.pathname}${target.search}${target.hash}`)
        return
      }
      if (message._tag === "notify") {
        callbacks.notify(message.message, message.level)
        return
      }
      if (message._tag === "confirm") {
        runFork(
          Effect.promise(() => callbacks.confirm(message.title, message.message)).pipe(
            Effect.tap((confirmed) =>
              Effect.sync(() => post({ _tag: "confirm-result", requestId: message.requestId, confirmed })),
            ),
          ),
        )
        return
      }
      if (message._tag !== "dispatch") return
      if (requests.has(message.requestId) || runtime === null) {
        post({
          _tag: "action-result",
          requestId: message.requestId,
          outcome: { _tag: "Rejected", reason: runtime === null ? "closed" : "duplicate-request" },
        })
        return
      }
      requests.add(message.requestId)
      const identity = runtime
      runFork(
        withApi((api) =>
          api.webSurfaces.dispatch({
            params: {
              id: sessionId,
              runtimeId: identity.runtimeId as never,
              surfaceId: catalog.surfaceId,
              candidateHash: catalog.candidateHash,
            },
            payload: { requestId: message.requestId, payload: message.payload },
          }),
        ).pipe(
          Effect.provideService(PiWebHttpClient, client),
          Effect.tap((outcome) =>
            Effect.sync(() => post({ _tag: "action-result", requestId: message.requestId, outcome })),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              post({
                _tag: "action-result",
                requestId: message.requestId,
                outcome: { _tag: "Failed", message: Cause.pretty(cause) },
              }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => requests.delete(message.requestId))),
        ),
      )
    }
    port.start()
    iframe.contentWindow?.postMessage(
      { type: "pi-suite-web-surface-port", contract: WEB_SURFACE_CHANNEL_CONTRACT },
      "*",
      [channel.port2],
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        post({ _tag: "closed", reason: "browser-scope-closed" })
        port.close()
        channel.port2.close()
        callbacks.state("failed", "拓展连接已关闭")
      }),
    )
    yield* Deferred.await(ready).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(() => new WebSurfaceFrameError({ message: "拓展页面未在 5 秒内就绪" })),
    )
    callbacks.state("ready")

    const events = yield* withApi((api) => api.sessions.events({ params: { id: sessionId } }))
    yield* events.pipe(
      Stream.runForEach((envelope) => {
        if (envelope.event._tag !== "RuntimeActivated" && envelope.event._tag !== "ExtensionUiChanged")
          return Effect.void
        if (runtime !== null && !sameRuntime(runtime, envelope.identity)) {
          return Effect.fail(new WebSurfaceFrameError({ message: "Session runtime 已替换" }))
        }
        runtime = envelope.identity
        const surface = envelope.event.projection.webSurfaces.find(
          (item) => item.surfaceId === catalog.surfaceId && item.candidateHash === catalog.candidateHash,
        )
        if (surface === undefined || surface.revision <= revision) return Effect.void
        revision = surface.revision
        if (!initialized) {
          initialized = true
          post({ _tag: "init", contract: WEB_SURFACE_CHANNEL_CONTRACT, sessionId, runtime, surface })
        } else post({ _tag: "projection", runtime, surface })
        return Effect.void
      }),
    )
  }).pipe(Effect.scoped)
