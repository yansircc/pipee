import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Effect } from "effect"
import { Link, useNavigate } from "@tanstack/react-router"
import type { WebSurfaceCatalog } from "@pi-suite/companion-contracts/web-surface"
import type { SessionSnapshot } from "@/api/contract"
import { runApi, runBrowser, withApi } from "@/browser/api-client"
import { connectWebSurface } from "@/browser/web-surface-channel"
import { PluginsConfig } from "./PluginsConfig"

export type ExtensionSearch = { readonly session?: string }
export const validateExtensionSearch = (input: Record<string, unknown>): ExtensionSearch =>
  typeof input.session === "string" && input.session.length > 0 ? { session: input.session } : {}

export function ExtensionShell({ sessionId, surfaceId }: { readonly sessionId?: string; readonly surfaceId?: string }) {
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<WebSurfaceCatalog | null>(null)
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frameState, setFrameState] = useState<{ state: "connecting" | "ready" | "failed"; message?: string }>({
    state: "connecting",
  })
  const [loadEpoch, setLoadEpoch] = useState(0)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    title: string
    message: string
    resolve: (confirmed: boolean) => void
  } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const refresh = useCallback(() => {
    if (sessionId === undefined) return () => undefined
    setError(null)
    return runApi(
      Effect.all({
        catalog: withApi((api) => api.webSurfaces.catalog({ params: { id: sessionId } })),
        snapshot: withApi((api) =>
          api.sessions.snapshot({ params: { id: sessionId }, query: { deferThinking: "1", deferMedia: "1" } }),
        ),
      }),
      {
        onSuccess: ({ catalog: nextCatalog, snapshot: nextSnapshot }) => {
          setCatalog(nextCatalog)
          setSnapshot(nextSnapshot)
        },
        onFailure: (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
      },
    )
  }, [sessionId])

  useEffect(() => refresh(), [refresh])
  useEffect(() => {
    if (notice === null) return
    return runBrowser(Effect.sleep("3 seconds"), { onSuccess: () => setNotice(null) })
  }, [notice])
  const selected = useMemo(
    () => catalog?.surfaces.find((surface) => surface.surfaceId === surfaceId) ?? null,
    [catalog, surfaceId],
  )

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null || selected === null || sessionId === undefined || loadEpoch === 0) return
    return runBrowser(
      connectWebSurface(iframe, sessionId, selected, {
        state: (state, message) => setFrameState({ state, ...(message === undefined ? {} : { message }) }),
        notify: (message) => {
          setNotice(message)
        },
        confirm: (title, message) => new Promise<boolean>((resolve) => setConfirmation({ title, message, resolve })),
        navigate: (path) => {
          const target = new URL(path, globalThis.location.origin)
          if (target.origin !== globalThis.location.origin) return
          const allowed =
            target.pathname === "/" || target.pathname === "/extensions" || target.pathname.startsWith("/extensions/")
          if (!allowed) return
          void navigate({
            to: target.pathname as never,
            search: sessionId === undefined ? {} : { session: sessionId },
          } as never)
        },
      }),
      {
        onSuccess: () => undefined,
        onFailure: (failure) =>
          setFrameState({ state: "failed", message: failure instanceof Error ? failure.message : String(failure) }),
      },
    )
  }, [loadEpoch, navigate, selected, sessionId])

  if (sessionId === undefined) {
    return (
      <section className="flex h-full items-center justify-center p-8 text-center text-text-muted">
        选择一个已有会话后才能使用拓展。这里不会自动创建 AgentSession。
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 bg-bg">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-bg-panel p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="font-semibold">拓展</h1>
          <button className="text-xs text-accent" onClick={() => setPluginsOpen(true)}>
            管理
          </button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {catalog?.surfaces.map((surface) => (
            <Link
              key={surface.surfaceId}
              to="/extensions/$surfaceId"
              params={{ surfaceId: surface.surfaceId }}
              search={{ session: sessionId }}
              className={`rounded-md px-3 py-2 text-sm hover:bg-bg-hover ${surface.surfaceId === surfaceId ? "bg-bg-selected" : ""}`}
            >
              <div className="font-medium">{surface.title}</div>
              <div className="truncate text-xs text-text-dim">{surface.packageName}</div>
            </Link>
          ))}
          {catalog !== null && catalog.surfaces.length === 0 && (
            <p className="p-2 text-sm text-text-muted">当前会话没有可用 Web Surface。</p>
          )}
        </div>
      </aside>
      <div className="relative min-h-0 min-w-0 flex-1">
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-text-muted">从左侧选择一个拓展。</div>
        ) : (
          <>
            <iframe
              key={`${selected.surfaceId}:${selected.candidateHash}`}
              ref={iframeRef}
              title={selected.title}
              src={selected.documentUrl}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-white"
              onLoad={() => setLoadEpoch((value) => value + 1)}
            />
            {frameState.state !== "ready" && (
              <div className="absolute inset-x-4 bottom-4 rounded-md bg-bg-panel/95 p-3 text-sm shadow">
                {frameState.message ?? "正在连接拓展…"}
              </div>
            )}
          </>
        )}
        {notice && (
          <div className="absolute top-4 right-4 rounded-md bg-bg-panel px-4 py-2 text-sm shadow">{notice}</div>
        )}
      </div>
      {pluginsOpen && (
        <PluginsConfig
          cwd={snapshot?.info?.cwd ?? null}
          sessionId={sessionId}
          chromeHealth={null}
          weixinStatus={undefined}
          onClose={() => setPluginsOpen(false)}
          onReloaded={() => {
            setPluginsOpen(false)
            refresh()
          }}
        />
      )}
      {confirmation && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-bg p-5 shadow-xl">
            <h2 className="font-semibold">{confirmation.title}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">{confirmation.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5"
                onClick={() => {
                  confirmation.resolve(false)
                  setConfirmation(null)
                }}
              >
                取消
              </button>
              <button
                className="rounded bg-accent px-3 py-1.5 text-white"
                onClick={() => {
                  confirmation.resolve(true)
                  setConfirmation(null)
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
