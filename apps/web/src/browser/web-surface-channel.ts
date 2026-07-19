import { Cause, Data, Deferred, Effect, FiberSet, Option, Schema, Stream } from "effect"
import {
  WEB_SURFACE_CHANNEL_CONTRACT,
  WebSurfaceClientMessage,
  type WebSurfaceCatalogItem,
  type WebSurfaceHostMessage,
  type WebSurfaceSessionContext,
} from "@pi-suite/companion-contracts/web-surface"
import { PiWebHttpClient, withApi } from "./http-api-client"
import { advanceWebSurfaceSessionChannel, type WebSurfaceSessionChannelState } from "./web-surface-channel-state"

export class WebSurfaceFrameError extends Data.TaggedError("WebSurfaceFrameError")<{ readonly message: string }> {}

export interface WebSurfaceChannelCallbacks {
  readonly navigate: (path: string) => void
  readonly notify: (message: string, level: "info" | "warning" | "error") => void
  readonly confirm: (title: string, message: string) => Promise<boolean>
  readonly state: (state: "connecting" | "ready" | "failed", message?: string) => void
}

export interface WebSurfaceChannelBinding {
  readonly session: WebSurfaceSessionContext
  readonly catalog: WebSurfaceCatalogItem
}

const decodeClientMessage = Schema.decodeUnknownOption(WebSurfaceClientMessage)
export const connectWebSurface = (
  iframe: HTMLIFrameElement,
  bindings: ReadonlyArray<WebSurfaceChannelBinding>,
  sessions: ReadonlyArray<WebSurfaceSessionContext>,
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
    const bindingBySession = new Map(bindings.map((binding) => [binding.session.sessionId, binding]))
    const stateBySession = new Map<string, WebSurfaceSessionChannelState>()

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
      const binding = bindingBySession.get(message.sessionId)
      const sessionState = stateBySession.get(message.sessionId)
      if (requests.has(message.requestId) || sessionState?.initialized !== true || binding === undefined) {
        post({
          _tag: "action-result",
          requestId: message.requestId,
          outcome: {
            _tag: "Rejected",
            reason: requests.has(message.requestId) ? "duplicate-request" : "session-not-active",
          },
        })
        return
      }
      requests.add(message.requestId)
      const identity = sessionState.runtime
      runFork(
        withApi((api) =>
          api.webSurfaces.dispatch({
            params: {
              id: message.sessionId,
              runtimeId: identity.runtimeId as never,
              surfaceId: binding.catalog.surfaceId,
              candidateHash: binding.catalog.candidateHash,
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
    post({ _tag: "sessions", sessions })
    callbacks.state("ready")

    yield* Effect.forEach(
      bindings,
      (binding) =>
        withApi((api) => api.sessions.events({ params: { id: binding.session.sessionId } })).pipe(
          Effect.provideService(PiWebHttpClient, client),
          Effect.flatMap((events) =>
            events.pipe(
              Stream.runForEach((envelope) => {
                if (envelope.event._tag !== "RuntimeActivated" && envelope.event._tag !== "ExtensionUiChanged")
                  return Effect.void
                const sessionId = binding.session.sessionId
                const surface = envelope.event.projection.webSurfaces.find(
                  (item) =>
                    item.surfaceId === binding.catalog.surfaceId &&
                    item.candidateHash === binding.catalog.candidateHash,
                )
                const transition = advanceWebSurfaceSessionChannel(
                  stateBySession.get(sessionId),
                  envelope.identity,
                  surface,
                )
                stateBySession.set(sessionId, transition.state)
                if (transition.closeReason !== undefined) {
                  post({ _tag: "session-closed", sessionId, reason: transition.closeReason })
                }
                if (surface === undefined || transition.delivery === undefined) return Effect.void
                if (transition.delivery === "init") {
                  post({
                    _tag: "init",
                    contract: WEB_SURFACE_CHANNEL_CONTRACT,
                    session: binding.session,
                    runtime: envelope.identity,
                    surface,
                  })
                } else {
                  post({
                    _tag: "projection",
                    session: binding.session,
                    runtime: envelope.identity,
                    surface,
                  })
                }
                return Effect.void
              }),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const sessionId = binding.session.sessionId
              stateBySession.delete(sessionId)
              post({ _tag: "session-closed", sessionId, reason: Cause.pretty(cause) })
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
  }).pipe(Effect.scoped)
