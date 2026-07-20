import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { useNavigate } from "@tanstack/react-router"
import type { SessionInfo } from "@/api/contract"
import { runApi, runBrowser, withApi } from "@/browser/api-client"
import { connectWebSurface } from "@/browser/web-surface-channel"
import { observeRunningSessions } from "@/features/session/session-controller"
import {
  groupWebSurfaceCatalogs,
  webSurfaceSessionContext,
  type ExtensionCatalogState,
  type ResolvedWebSurfaceCatalog,
} from "@/lib/web-surface-catalog-group"
import { useToast } from "@/ui/feedback/Toast"

export const readWebSurfaceCatalogs = Effect.gen(function* () {
  const index = yield* withApi((api) => api.sessions.list({}))
  const representativeByCwd = new Map<string, SessionInfo>()
  for (const session of index.sessions) {
    const current = representativeByCwd.get(session.cwd)
    if (current === undefined || session.modified > current.modified) representativeByCwd.set(session.cwd, session)
  }
  const catalogs = yield* Effect.forEach(
    representativeByCwd.values(),
    (representative) =>
      withApi((api) => api.webSurfaces.catalog({ params: { id: representative.id } })).pipe(
        Effect.map((catalog): ResolvedWebSurfaceCatalog => ({ cwd: representative.cwd, representative, catalog })),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  )
  return groupWebSurfaceCatalogs(
    index,
    catalogs.filter((catalog): catalog is ResolvedWebSurfaceCatalog => catalog !== null),
  )
})

export function ExtensionShell({ surfaceId }: { readonly surfaceId?: string }) {
  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<ExtensionCatalogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frameState, setFrameState] = useState<{ state: "connecting" | "ready" | "failed"; message?: string }>({
    state: "connecting",
  })
  const [loadEpoch, setLoadEpoch] = useState(0)
  const { push: pushToast } = useToast()
  const [confirmation, setConfirmation] = useState<{
    title: string
    message: string
    resolve: (confirmed: boolean) => void
  } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const runningFingerprintRef = useRef("")

  const refresh = useCallback(() => {
    setError(null)
    return runApi(readWebSurfaceCatalogs, {
      onSuccess: (next) => {
        runningFingerprintRef.current = [...next.index.runningSessionIds].sort().join("\0")
        setCatalog(next)
      },
      onFailure: (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
    })
  }, [])

  useEffect(() => refresh(), [refresh])
  useEffect(
    () =>
      runApi(
        observeRunningSessions({
          onSnapshot: (sessionIds) => {
            const fingerprint = [...sessionIds].sort().join("\0")
            if (fingerprint === runningFingerprintRef.current) return
            runningFingerprintRef.current = fingerprint
            refresh()
          },
          onTransientError: () => undefined,
        }),
        { onSuccess: () => undefined },
      ),
    [refresh],
  )
  const selected = useMemo(
    () => catalog?.groups.find((group) => group.item.surfaceId === surfaceId) ?? null,
    [catalog, surfaceId],
  )
  const sessions = useMemo(() => catalog?.index.sessions.map(webSurfaceSessionContext) ?? [], [catalog])

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null || selected === null || loadEpoch === 0) return
    return runBrowser(
      connectWebSurface(iframe, selected.bindings, sessions, {
        state: (state, message) => setFrameState({ state, ...(message === undefined ? {} : { message }) }),
        notify: (message) => pushToast({ message, source: "extension", type: "info" }),
        confirm: (title, message) => new Promise<boolean>((resolve) => setConfirmation({ title, message, resolve })),
        navigate: (path) => {
          const target = new URL(path, globalThis.location.origin)
          if (target.origin !== globalThis.location.origin) return
          if (target.pathname === "/api/packages/plugins/pi-chrome/browser-extension.zip") {
            const anchor = document.createElement("a")
            anchor.href = `${target.pathname}${target.search}`
            anchor.download = "pi-chrome-extension.zip"
            anchor.click()
            return
          }
          const allowed =
            target.pathname === "/" || target.pathname === "/extensions" || target.pathname.startsWith("/extensions/")
          if (!allowed) return
          void navigate({ to: `${target.pathname}${target.search}${target.hash}` as never })
        },
      }),
      {
        onSuccess: () => undefined,
        onFailure: (failure) =>
          setFrameState({ state: "failed", message: failure instanceof Error ? failure.message : String(failure) }),
      },
    )
  }, [loadEpoch, navigate, pushToast, selected, sessions])

  return (
    <section {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.workspace)}>
        <header {...stylex.props(styles.header)}>
          <button type="button" onClick={() => void navigate({ to: "/" })} {...stylex.props(styles.backButton)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
            返回主页面
          </button>
          <div {...stylex.props(styles.heading)}>
            <strong>{selected?.item.title ?? "拓展页面"}</strong>
            {selected && <span>{selected.item.packageName}</span>}
          </div>
          <span {...stylex.props(styles.connection, frameState.state === "ready" && styles.connectionReady)}>
            <i />
            {frameState.state === "ready" ? "已连接" : frameState.state === "failed" ? "连接失败" : "连接中"}
          </span>
        </header>
        <div {...stylex.props(styles.surfaceWorkspace)}>
          {surfaceId === undefined || selected === null ? (
            <div {...stylex.props(styles.emptyWorkspace)}>这个 Web Surface 当前不可用。</div>
          ) : (
            <>
              <iframe
                key={`${selected.item.surfaceId}:${selected.item.candidateHash}`}
                ref={iframeRef}
                title={selected.item.title}
                src={selected.item.documentUrl}
                sandbox="allow-scripts"
                {...stylex.props(styles.frame)}
                onLoad={() => {
                  setFrameState({ state: "connecting" })
                  setLoadEpoch((value) => value + 1)
                }}
              />
              {frameState.state !== "ready" && (
                <div {...stylex.props(styles.frameState)}>{frameState.message ?? "正在连接拓展…"}</div>
              )}
            </>
          )}
        </div>
        {error && <div {...stylex.props(styles.error)}>{error}</div>}
      </div>
      {confirmation && (
        <div {...stylex.props(styles.overlay)}>
          <div {...stylex.props(styles.confirmation)}>
            <h2 {...stylex.props(styles.confirmationTitle)}>{confirmation.title}</h2>
            <p {...stylex.props(styles.confirmationMessage)}>{confirmation.message}</p>
            <div {...stylex.props(styles.confirmationActions)}>
              <button
                {...stylex.props(styles.button)}
                onClick={() => {
                  confirmation.resolve(false)
                  setConfirmation(null)
                }}
              >
                取消
              </button>
              <button
                {...stylex.props(styles.button, styles.primaryButton)}
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

const styles = stylex.create({
  shell: { backgroundColor: "var(--bg)", display: "flex", height: "100%", minHeight: 0 },
  header: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexShrink: 0,
    gap: 18,
    height: 58,
    paddingInline: 18,
  },
  backButton: {
    alignItems: "center",
    backgroundColor: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    fontSize: 12,
    gap: 5,
    height: 32,
    paddingInline: 10,
  },
  heading: {
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    gap: 2,
    minWidth: 0,
  },
  connection: {
    alignItems: "center",
    color: "var(--text-dim)",
    display: "flex",
    fontSize: 11,
    gap: 5,
    marginLeft: "auto",
  },
  connectionReady: { color: "var(--success)" },
  surfaceWorkspace: { flex: 1, minHeight: 0, position: "relative" },
  workspace: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    position: "relative",
  },
  emptyWorkspace: {
    alignItems: "center",
    color: "var(--text-muted)",
    display: "flex",
    height: "100%",
    justifyContent: "center",
  },
  frame: { backgroundColor: "white", border: 0, height: "100%", width: "100%" },
  frameState: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    bottom: 16,
    boxShadow: "0 8px 30px rgba(0,0,0,.12)",
    fontSize: 12,
    left: 16,
    padding: 12,
    position: "absolute",
    right: 16,
  },
  error: { bottom: 16, color: "#ef4444", fontSize: 12, left: 16, position: "absolute" },
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,.4)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    padding: 16,
    position: "fixed",
    zIndex: 500,
  },
  confirmation: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    boxShadow: "0 20px 60px rgba(0,0,0,.22)",
    maxWidth: 440,
    padding: 20,
    width: "100%",
  },
  confirmationTitle: { fontSize: 15, margin: 0 },
  confirmationMessage: {
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.6,
    marginBlock: 10,
    whiteSpace: "pre-wrap",
  },
  confirmationActions: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 },
  button: {
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text)",
    cursor: "pointer",
    paddingBlock: 7,
    paddingInline: 12,
  },
  primaryButton: {
    backgroundColor: "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 7,
    color: "white",
    cursor: "pointer",
    paddingBlock: 8,
    paddingInline: 12,
  },
})
