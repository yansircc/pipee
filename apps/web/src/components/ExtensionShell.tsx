import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { Link, useNavigate } from "@tanstack/react-router"
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
import { PluginsConfig } from "./PluginsConfig"

const readCatalogs = Effect.gen(function* () {
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
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{
    title: string
    message: string
    resolve: (confirmed: boolean) => void
  } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const runningFingerprintRef = useRef("")

  const refresh = useCallback(() => {
    setError(null)
    return runApi(readCatalogs, {
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
  useEffect(() => {
    if (notice === null) return
    return runBrowser(Effect.sleep("3 seconds"), { onSuccess: () => setNotice(null) })
  }, [notice])

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
        notify: (message) => setNotice(message),
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
  }, [loadEpoch, navigate, selected, sessions])

  const projectCwds = useMemo(() => {
    return [...new Set((catalog?.index.sessions ?? []).map((session) => session.cwd))].sort()
  }, [catalog])

  return (
    <section {...stylex.props(styles.shell)}>
      <aside {...stylex.props(styles.catalog)}>
        <div {...stylex.props(styles.catalogHeader)}>
          <h1 {...stylex.props(styles.catalogTitle)}>拓展</h1>
        </div>
        <div {...stylex.props(styles.catalogLabel)}>插件管理</div>
        <Link
          to="/extensions"
          {...stylex.props(styles.surfaceLink, surfaceId === undefined && styles.surfaceLinkActive)}
        >
          <span {...stylex.props(styles.surfaceIcon, styles.managerIcon)}>田</span>
          <span {...stylex.props(styles.surfaceCopy)}>
            <b>已安装拓展</b>
            <span>增删查改 · 激活与禁用</span>
          </span>
        </Link>
        <div {...stylex.props(styles.catalogLabel)}>拓展页面</div>
        <div {...stylex.props(styles.surfaceList)}>
          {catalog?.groups.map((group) => (
            <Link
              key={group.item.surfaceId}
              to="/extensions/$surfaceId"
              params={{ surfaceId: group.item.surfaceId }}
              {...stylex.props(styles.surfaceLink, group.item.surfaceId === surfaceId && styles.surfaceLinkActive)}
            >
              <span {...stylex.props(styles.surfaceIcon)}>{group.item.title.slice(0, 1)}</span>
              <span {...stylex.props(styles.surfaceCopy)}>
                <b>{group.item.title}</b>
                <span>{group.item.packageName}</span>
              </span>
              <i {...stylex.props(styles.surfaceDot)} />
            </Link>
          ))}
          {catalog !== null && catalog.groups.length === 0 && (
            <p {...stylex.props(styles.emptyCatalog)}>当前 Pi 没有可用 Web Surface。</p>
          )}
        </div>
      </aside>
      <div {...stylex.props(styles.workspace)}>
        {surfaceId === undefined ? (
          <PluginsConfig
            presentation="page"
            cwd={null}
            sessionId={null}
            projectCwds={projectCwds}
            chromeHealth={null}
            weixinStatus={undefined}
            onClose={() => undefined}
            onOpenPackage={(packageName) => {
              const group = catalog?.groups.find((candidate) => candidate.item.packageName === packageName)
              if (group) {
                void navigate({
                  to: "/extensions/$surfaceId",
                  params: { surfaceId: group.item.surfaceId },
                })
              }
            }}
            onReloaded={refresh}
          />
        ) : selected === null ? (
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
              onLoad={() => setLoadEpoch((value) => value + 1)}
            />
            {frameState.state !== "ready" && (
              <div {...stylex.props(styles.frameState)}>{frameState.message ?? "正在连接拓展…"}</div>
            )}
          </>
        )}
        {error && <div {...stylex.props(styles.error)}>{error}</div>}
        {notice && <div {...stylex.props(styles.notice)}>{notice}</div>}
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
  catalog: {
    backgroundColor: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    width: { default: 224, "@media (max-width: 720px)": 76 },
  },
  catalogHeader: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    height: 64,
    paddingInline: 16,
  },
  catalogTitle: { fontSize: 17, margin: 0 },
  catalogLabel: { color: "var(--text-dim)", fontSize: 10, fontWeight: 700, paddingBlock: 10, paddingInline: 14 },
  surfaceList: { display: "flex", flexDirection: "column", gap: 3, paddingInline: 7 },
  surfaceLink: {
    alignItems: "center",
    borderRadius: 10,
    color: "var(--text-muted)",
    display: "flex",
    gap: 10,
    marginInline: 7,
    minHeight: 56,
    paddingBlock: 8,
    paddingInline: 10,
    textDecoration: "none",
    backgroundColor: { default: "transparent", ":hover": "var(--bg-hover)" },
  },
  surfaceLinkActive: { backgroundColor: "var(--bg-selected)", color: "var(--text)" },
  surfaceIcon: {
    alignItems: "center",
    backgroundColor: "var(--accent)",
    borderRadius: 9,
    color: "white",
    display: "flex",
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  managerIcon: { backgroundColor: "#3478f6" },
  surfaceCopy: {
    display: { default: "flex", "@media (max-width: 720px)": "none" },
    flex: 1,
    flexDirection: "column",
    fontSize: 11,
    gap: 3,
    minWidth: 0,
  },
  surfaceDot: { backgroundColor: "#22c55e", borderRadius: "50%", height: 7, width: 7 },
  emptyCatalog: { color: "var(--text-muted)", fontSize: 12, padding: 12 },
  workspace: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", position: "relative" },
  manager: { display: "flex", flexDirection: "column", height: "100%" },
  managerHeader: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    minHeight: 64,
    paddingInline: 24,
  },
  managerTitle: { fontSize: 18, margin: 0 },
  managerSubtitle: { color: "var(--text-muted)", fontSize: 11, marginBlock: 4 },
  managerBody: {
    alignItems: "flex-start",
    display: "flex",
    flex: 1,
    flexDirection: "column",
    gap: 14,
    overflow: "auto",
    padding: 24,
  },
  managerIntro: { color: "var(--text-muted)", fontSize: 13, margin: 0 },
  manageButton: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    cursor: "pointer",
    paddingBlock: 9,
    paddingInline: 13,
  },
  diagnostics: { color: "#d97706", fontSize: 11, whiteSpace: "pre-wrap" },
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
  notice: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 8px 30px rgba(0,0,0,.12)",
    fontSize: 12,
    paddingBlock: 8,
    paddingInline: 12,
    position: "absolute",
    right: 16,
    top: 16,
  },
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
