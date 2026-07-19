import { Suspense, useState, useCallback, useRef, useEffect, useMemo } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect, Schedule } from "effect"
import { getRouteApi } from "@tanstack/react-router"
import { SessionSidebar } from "./SessionSidebar"
import { ChatWindow } from "./ChatWindow"
import { FileExplorer } from "./FileExplorer"
import { readWebSurfaceCatalogs } from "./ExtensionShell"
import { TabBar, type Tab } from "./TabBar"
import { BranchNavigator } from "./BranchNavigator"
import { useTheme } from "@/hooks/useTheme"
import { useIsMobile } from "@/hooks/useIsMobile"
import { copyText } from "@/lib/clipboard"
import { getFileName } from "@/lib/file-paths"
import { buildAtMentionText } from "@/lib/file-fuzzy"
import type { SessionBranchNode, SessionInfo, SessionStats, WeixinStatusProjection } from "@/api/contract"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { useI18n } from "@/lib/i18n"
import { withApi, apiUrls, runApi, runBrowser, type Cancel } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { FileViewer, ModelsConfig, PluginsConfig, SkillsConfig } from "@/browser/code-split"
import { sessionController } from "@/features/session/session-controller"
import { DEFAULT_TOOL_PRESET, getToolNamesForPreset } from "@/lib/tool-presets"
import { probeChromeExtension, type ChromeExtensionHealth } from "@/lib/chrome-extension-installation"
import { useBrowserPreferences } from "@/browser/preferences-react"
import type { ExtensionCatalogState } from "@/lib/web-surface-catalog-group"
type SessionCopyField = "file" | "id"
type SettingsSurface =
  | { readonly kind: "general" }
  | { readonly kind: "models" }
  | { readonly kind: "skills" }
  | { readonly initialPackageName?: string; readonly kind: "plugins" }
  | null
const indexRoute = getRouteApi("/")
export function AppShell() {
  const { locale, setLocale, t: tr } = useI18n()
  const navigate = indexRoute.useNavigate()
  const search = indexRoute.useSearch()
  const { isDark, toggleTheme } = useTheme()
  const { preferences, updatePreferences } = useBrowserPreferences()
  const isMobile = useIsMobile()
  const [sessionCollection, setSessionCollection] = useState<SessionInfo[]>([])
  const selectedSession = useMemo(
    () =>
      search.session === undefined
        ? null
        : (sessionCollection.find((candidate) => candidate.id === search.session) ?? null),
    [search.session, sessionCollection],
  )
  const [creatingSessionCwd, setCreatingSessionCwd] = useState<string | null>(null)
  const [createSessionError, setCreateSessionError] = useState<string | null>(null)
  const [inputFocusEpoch, setInputFocusEpoch] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const sessionProjectionOwner = selectedSession === null ? "none" : `session:${selectedSession.id}`
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0)
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0)
  const [settingsSurface, setSettingsSurface] = useState<SettingsSurface>(null)
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0)
  const [skillsCount, setSkillsCount] = useState(0)
  const [activeExtensionCount, setActiveExtensionCount] = useState(0)
  const [extensionCatalog, setExtensionCatalog] = useState<ExtensionCatalogState | null>(null)
  const [chromeExtensionHealth, setChromeExtensionHealth] = useState<ChromeExtensionHealth | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false)
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])
  useEffect(() => {
    setMobileSidebarReady(true)
  }, [])
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const topBarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const check = withApi((api) => api.packages.globalChromePlugin()).pipe(
      Effect.flatMap((response) => probeChromeExtension(response.package)),
      Effect.tap((health) => Effect.sync(() => setChromeExtensionHealth(health))),
      Effect.catch(() => Effect.void),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
      }),
    )
    return runApi(check, {
      onSuccess: () => undefined,
    })
  }, [])

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchNodes, setBranchNodes] = useState<SessionBranchNode[]>([])
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null)
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null)
  const handleBranchDataChange = useCallback(
    (nodes: SessionBranchNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
      setBranchNodes(nodes)
      setBranchActiveLeafId(activeLeafId)
      branchLeafChangeFnRef.current = onLeafChange
    },
    [],
  )
  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId)
  }, [])
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null)
  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt)
  }, [])

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const handleSessionStatsChange = useCallback((stats: SessionStats | null) => {
    setSessionStats(stats)
  }, [])
  const [weixinStatus, setWeixinStatus] = useState<WeixinStatusProjection | undefined>(undefined)
  const handleWeixinStatusChange = useCallback((status: WeixinStatusProjection) => {
    setWeixinStatus(status)
  }, [])
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null)
  const sessionCopyTimerRef = useRef<Cancel | null>(null)
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    sessionCopyTimerRef.current?.()
    sessionCopyTimerRef.current = runBrowser(
      copyText(value).pipe(
        Effect.tap(() => Effect.sync(() => setCopiedSessionField(field))),
        Effect.andThen(Effect.sleep("1400 millis")),
        Effect.tap(() => Effect.sync(() => setCopiedSessionField(null))),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [])
  useEffect(() => {
    return () => {
      sessionCopyTimerRef.current?.()
    }
  }, [])

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{
    percent: number | null
    contextWindow: number
    tokens: number | null
  } | null>(null)
  const handleContextUsageChange = useCallback(
    (
      usage: {
        percent: number | null
        contextWindow: number
        tokens: number | null
      } | null,
    ) => {
      setContextUsage(usage)
    },
    [],
  )
  useEffect(() => {
    setSessionStats(null)
    setContextUsage(null)
  }, [sessionProjectionOwner])

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "session" | null>(null)
  const [topPanelPos, setTopPanelPos] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const toggleTopPanel = useCallback(
    (panel: "branches" | "session") => {
      if (isMobile) setSidebarOpen(false)
      setActiveTopPanel((cur) => (cur === panel ? null : panel))
    },
    [isMobile],
  )
  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false)
    setActiveTopPanel("session")
  }, [isMobile])
  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null)
    setSidebarOpen((open) => !open)
  }, [isMobile])
  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect()
      setTopPanelPos({
        top: rect.bottom,
        left: rect.left,
        width: rect.width,
      })
    }
    return runBrowser(
      BrowserPlatform.pipe(Effect.flatMap((browser) => browser.observeResize([topBarRef.current!], update))),
      {
        onSuccess: () => undefined,
      },
    )
  }, [activeTopPanel])
  useEffect(() => {
    if (activeTopPanel !== "session") return
    const close = (event: MouseEvent) => {
      if (!topBarRef.current?.contains(event.target as Node)) setActiveTopPanel(null)
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.onDocumentMouseDown(close))), {
      onSuccess: () => undefined,
    })
  }, [activeTopPanel])

  // Resource manager owns the file tree and preview tabs.
  const [fileTabs, setFileTabs] = useState<Tab[]>([])
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null)
  const [resourceManagerOpen, setResourceManagerOpen] = useState(false)

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir))
  }, [])
  const [initialSessionId] = useState<string | null>(() => search.session ?? null)
  const [activeCwd, setActiveCwd] = useState<string | null>(null)
  const managementCwd = activeCwd ?? selectedSession?.cwd ?? null
  useEffect(() => {
    if (managementCwd === null) {
      setSkillsCount(0)
      return
    }
    return runApi(
      withApi((api) => api.packages.skills({ query: { cwd: managementCwd } })),
      {
        onSuccess: (response) => setSkillsCount(response.skills.length),
        onFailure: () => setSkillsCount(0),
      },
    )
  }, [managementCwd, settingsSurface])
  useEffect(
    () =>
      runApi(
        withApi((api) => api.packages.pluginOverview()),
        {
          onSuccess: (plugins) => setActiveExtensionCount(plugins.packages.filter((pkg) => !pkg.disabled).length),
          onFailure: () => undefined,
        },
      ),
    [settingsSurface],
  )
  useEffect(() => {
    if (settingsSurface?.kind !== "plugins") return
    return runApi(readWebSurfaceCatalogs, {
      onSuccess: setExtensionCatalog,
      onFailure: () => setExtensionCatalog(null),
    })
  }, [settingsSurface])
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => search.session === undefined)
  // Suppresses draft replacement in handleCwdChange during the initial URL restore.
  const suppressCwdResetRef = useRef(false)
  const handleCwdChange = useCallback(
    (cwd: string | null, projectRoot?: string | null) => {
      setActiveCwd(cwd)
      // Skip if cwd is null (initial mount) or during the initial URL restore.
      if (!cwd) return
      if (suppressCwdResetRef.current) {
        suppressCwdResetRef.current = false
        return
      }
      // Worktrees of one repo share a project root. Moving the effective cwd
      // within the same project (e.g. switching worktree, or clicking a session
      // that lives in another worktree) must not close the open session.
      const newProject = projectRoot ?? cwd
      if (selectedSession && (selectedSession.projectRoot ?? selectedSession.cwd) === newProject) {
        return
      }
      // Close any session that belongs to a different project — it no longer
      // matches the selected project directory.
      setCreateSessionError(null)
      setBranchNodes([])
      setBranchActiveLeafId(null)
      setSystemPrompt(null)
      setActiveTopPanel(null)
      void navigate({
        to: "/",
        search: {},
        replace: true,
      })
    },
    [navigate, selectedSession],
  )
  const handleSelectSession = useCallback(
    (session: SessionInfo, isRestore = false) => {
      setSessionCollection((current) =>
        current.some((candidate) => candidate.id === session.id)
          ? current.map((candidate) => (candidate.id === session.id ? session : candidate))
          : [...current, session],
      )
      setSystemPrompt(null)
      setInitialSessionRestored(true)
      // On mobile, collapse the overlay drawer so the chat is revealed after pick.
      if (isMobile && !isRestore) setSidebarOpen(false)
      if (isRestore) {
        // The URL already owns this restored identity. Ignore the sidebar's
        // corresponding cwd projection instead of creating a new draft.
        suppressCwdResetRef.current = true
      }
      // Skip router.replace when restoring from URL: the search param already
      // owns the current session identity.
      if (!isRestore) {
        void navigate({
          to: "/",
          search: {
            session: session.id,
          },
          replace: true,
        })
      }
    },
    [navigate, isMobile],
  )
  const acceptCreatedSession = useCallback(
    (session: SessionInfo) => {
      setSessionCollection((current) =>
        current.some((candidate) => candidate.id === session.id)
          ? current.map((candidate) => (candidate.id === session.id ? session : candidate))
          : [...current, session],
      )
      setRefreshKey((key) => key + 1)
      void navigate({
        to: "/",
        search: {
          session: session.id,
        },
        replace: true,
      })
    },
    [navigate],
  )
  const handleNewSession = useCallback(
    (cwd: string) => {
      if (creatingSessionCwd !== null) return
      setInputFocusEpoch((epoch) => epoch + 1)
      setCreatingSessionCwd(cwd)
      setCreateSessionError(null)
      setBranchNodes([])
      setBranchActiveLeafId(null)
      setSystemPrompt(null)
      setActiveTopPanel(null)
      if (isMobile) setSidebarOpen(false)
      void navigate({
        to: "/",
        search: {},
        replace: true,
      })
      runApi(sessionController.create(cwd, getToolNamesForPreset(DEFAULT_TOOL_PRESET), null), {
        onSuccess: (session) => {
          setCreatingSessionCwd(null)
          acceptCreatedSession({
            ...session,
          })
        },
        onFailure: (error) => {
          setCreatingSessionCwd(null)
          setCreateSessionError(error instanceof Error ? error.message : String(error))
        },
      })
    },
    [acceptCreatedSession, creatingSessionCwd, isMobile, navigate],
  )
  useEffect(
    () =>
      runApi(
        withApi((api) => api.sessions.list({})),
        {
          onSuccess: ({ sessions }) =>
            setSessionCollection(
              sessions.map((candidate) => ({
                ...candidate,
              })),
            ),
        },
      ),
    [refreshKey],
  )
  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1)
    setExplorerRefreshKey((k) => k + 1)
  }, [])
  const handleSessionIndexChanged = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])
  const handleSessionForked = useCallback(
    (newSessionId: string) => {
      setRefreshKey((k) => k + 1)
      setSessionCollection((current) => {
        const parent =
          search.session === undefined ? undefined : current.find((candidate) => candidate.id === search.session)
        const fork = {
          ...(parent ?? {
            path: "",
            cwd: "",
            created: "",
            modified: "",
            messageCount: 0,
            firstMessage: "",
          }),
          id: newSessionId,
        }
        return [...current.filter((candidate) => candidate.id !== newSessionId), fork]
      })
      void navigate({
        to: "/",
        search: {
          session: newSessionId,
        },
        replace: true,
      })
    },
    [navigate, search.session],
  )
  const handleInitialRestoreDone = useCallback(() => {
    if (search.session !== undefined) {
      void navigate({
        to: "/",
        search: {},
        replace: true,
      })
    }
    setInitialSessionRestored(true)
  }, [navigate, search.session])
  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      setSessionCollection((current) => current.filter((session) => session.id !== sessionId))
      setRefreshKey((k) => k + 1)
      if (selectedSession?.id === sessionId) {
        setBranchNodes([])
        setBranchActiveLeafId(null)
        setSystemPrompt(null)
        setActiveTopPanel(null)
        void navigate({
          to: "/",
          search: {},
          replace: true,
        })
      }
    },
    [selectedSession, navigate],
  )
  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, sourceSessionId?: string | null) => {
      const tabId = `file:${filePath}`
      setFileTabs((prev) => {
        const existing = prev.find((t) => t.id === tabId)
        if (!existing)
          return [
            ...prev,
            {
              id: tabId,
              label: fileName,
              filePath,
              sourceSessionId,
            },
          ]
        if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev
        return prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                sourceSessionId,
              }
            : t,
        )
      })
      setActiveFileTabId(tabId)
      setResourceManagerOpen(true)
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false)
    },
    [isMobile],
  )
  const handleOpenLinkedFile = useCallback(
    (filePath: string) => {
      handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null)
    },
    [handleOpenFile, selectedSession?.id],
  )
  const handleCloseFileTab = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId)
        if (next.length === 0) setResourceManagerOpen(false)
        return next
      })
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur
        const remaining = fileTabs.filter((t) => t.id !== tabId)
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      })
    },
    [fileTabs],
  )
  const handleExportSession = useCallback(() => {
    if (!selectedSession) return
    runBrowser(
      BrowserPlatform.pipe(
        Effect.flatMap((browser) =>
          browser.navigate(
            apiUrls.sessions.export({
              params: {
                id: selectedSession.id,
              },
            }),
          ),
        ),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }, [selectedSession])
  const showChat = selectedSession !== null
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat
  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null
  const sidebarContent = (
    <SessionSidebar
      selectedSessionId={selectedSession?.id ?? null}
      onSelectSession={handleSelectSession}
      onNewSession={handleNewSession}
      newSessionPending={creatingSessionCwd !== null}
      initialSessionId={initialSessionId}
      onInitialRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      selectedCwd={selectedSession?.cwd ?? creatingSessionCwd ?? null}
      onCwdChange={handleCwdChange}
      onOpenExplorer={() => setResourceManagerOpen(true)}
      onOpenSettings={() => setSettingsSurface({ kind: "general" })}
    />
  )
  return (
    <>
      <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      .debug-control > span,
      .debug-control > svg:not(.debug-icon) {
        display: none !important;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
      <div {...stylex.props(inlineStyles.inline5)}>
        {/* Mobile overlay backdrop */}
        <div
          className={`${stylex.props(inlineStyles.inline6).className} sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          onClick={() => setSidebarOpen(false)}
          style={{
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? "auto" : "none",
          }}
        />

        {/* Left sidebar */}
        <div
          className={`${stylex.props(inlineStyles.inline7).className} sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        >
          {sidebarContent}
        </div>

        {/* Center: chat */}
        <div {...stylex.props(inlineStyles.inline8)}>
          {/* Top bar with sidebar toggle */}
          <div ref={topBarRef} {...stylex.props(inlineStyles.inline9)}>
            <button
              onClick={handleSidebarToggle}
              title={tr(sidebarOpen ? "Hide sidebar" : "Show sidebar")}
              aria-label={tr(sidebarOpen ? "Hide sidebar" : "Show sidebar")}
              {...stylex.props(inlineStyles.inline10)}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)"
              }}
            >
              {sidebarOpen ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
            <button
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                toggleTheme({
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                })
              }}
              title={tr(isDark ? "Switch to light mode" : "Switch to dark mode")}
              aria-label={tr(isDark ? "Switch to light mode" : "Switch to dark mode")}
              aria-pressed={isDark}
              {...stylex.props(inlineStyles.inline11)}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)"
              }}
            >
              {isDark ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <button
              onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}
              title={tr("Switch language")}
              aria-label={tr("Switch language")}
              {...stylex.props(inlineStyles.inline12)}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-muted)"
              }}
            >
              {locale === "zh-CN" ? "EN" : "中文"}
            </button>
            {showChat && (
              <div {...stylex.props(inlineStyles.inline13)}>
                <button
                  onClick={handleExportSession}
                  disabled={!selectedSession}
                  title={tr(selectedSession ? "Export HTML" : "Export is available after the session is saved")}
                  aria-label={tr("Export HTML")}
                  {...stylex.props(inlineStyles.inline14)}
                  style={{
                    color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: selectedSession ? "pointer" : "not-allowed",
                    opacity: selectedSession ? 1 : 0.45,
                  }}
                  onMouseEnter={(e) => {
                    if (!selectedSession) return
                    e.currentTarget.style.color = "var(--text)"
                    e.currentTarget.style.background = "var(--bg-hover)"
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)"
                    e.currentTarget.style.background = "none"
                  }}
                >
                  <span
                    {...stylex.props(inlineStyles.inline15)}
                    style={{
                      color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </span>
                </button>
                <BranchNavigator
                  branchNodes={branchNodes}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  inline
                  compact={isMobile}
                  containerRef={topBarRef}
                  open={activeTopPanel === "branches"}
                  onToggle={() => toggleTopPanel("branches")}
                  hasSession
                />
              </div>
            )}
            {/* Session stats — right-aligned in top bar */}
            {showChat &&
              (sessionStats || contextUsage) &&
              (() => {
                const t = sessionStats?.tokens
                const c = sessionStats?.cost ?? 0
                const fmt = (n: number) =>
                  n >= 1_000_000
                    ? `${(n / 1_000_000).toFixed(1)}M`
                    : n >= 1000
                      ? `${(n / 1000).toFixed(0)}k`
                      : String(n)
                const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null
                let ctxColor = "var(--text-muted)"
                let ctxStr: string | null = null
                if (contextUsage?.contextWindow) {
                  const pct = contextUsage.percent
                  if (pct !== null && pct > 90) ctxColor = "#ef4444"
                  else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)"
                  ctxStr =
                    pct !== null
                      ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}`
                      : `? / ${fmt(contextUsage.contextWindow)}`
                }
                return (
                  <button
                    className={`${stylex.props(inlineStyles.inline18).className} debug-control`}
                    type="button"
                    onClick={() => toggleTopPanel("session")}
                    title={tr("Debug information")}
                    aria-label={tr("Debug information")}
                    aria-pressed={activeTopPanel === "session"}
                    style={{
                      paddingInline: 10,
                      background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
                      borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--text)"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"
                    }}
                  >
                    <svg
                      className="debug-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M8 2h8M9 9h6M12 2v4M7 13H3M21 13h-4M7 17l-3 2M17 17l3 2" />
                      <rect x="7" y="6" width="10" height="16" rx="5" />
                    </svg>
                    {isMobile && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    )}
                    {!isMobile && t && t.input > 0 && (
                      <span {...stylex.props(inlineStyles.inline19)}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="5" y1="8.5" x2="5" y2="1.5" />
                          <polyline points="2 4 5 1.5 8 4" />
                        </svg>
                        {fmt(t.input)}
                      </span>
                    )}
                    {!isMobile && t && t.output > 0 && (
                      <span {...stylex.props(inlineStyles.inline20)}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="5" y1="1.5" x2="5" y2="8.5" />
                          <polyline points="2 6 5 8.5 8 6" />
                        </svg>
                        {fmt(t.output)}
                      </span>
                    )}
                    {!isMobile && t && t.cacheRead > 0 && (
                      <span {...stylex.props(inlineStyles.inline21)}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" />
                          <polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                        </svg>
                        {fmt(t.cacheRead)}
                      </span>
                    )}
                    {!isMobile && costStr && (
                      <span {...stylex.props(inlineStyles.inline22)}>
                        {tr("Session total")} {costStr}
                      </span>
                    )}
                    {ctxStr && (
                      <span
                        {...stylex.props(inlineStyles.inline23)}
                        style={{
                          color: ctxColor,
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" />
                          <line x1="1" y1="9" x2="9" y2="9" />
                        </svg>
                        {ctxStr}
                      </span>
                    )}
                  </button>
                )
              })()}
            {/* Top panel dropdown — shared, only one active at a time */}
            {activeTopPanel && topPanelPos && (
              <div
                {...stylex.props(inlineStyles.inline24)}
                style={{
                  top: topPanelPos.top,
                  left: topPanelPos.left,
                  width: topPanelPos.width,
                  maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
                }}
              >
                {activeTopPanel === "session" && (
                  <div className={`${stylex.props(inlineStyles.inline29).className} session-info-popover`}>
                    <button
                      type="button"
                      {...stylex.props(inlineStyles.copyDebug)}
                      onClick={() =>
                        runBrowser(
                          copyText(
                            JSON.stringify(
                              {
                                cwd: managementCwd,
                                session: sessionStats,
                                context: contextUsage,
                                weixin: weixinStatus,
                              },
                              null,
                              2,
                            ),
                          ),
                          { onSuccess: () => undefined },
                        )
                      }
                    >
                      {tr("Copy debug information")}
                    </button>
                    {sessionStats ? (
                      (() => {
                        const sessionRows = [
                          ...(sessionStats.sessionName
                            ? [
                                {
                                  label: "Name",
                                  value: sessionStats.sessionName,
                                  copyField: null,
                                },
                              ]
                            : []),
                          {
                            label: "File",
                            value: sessionStats.sessionFile ?? "In-memory",
                            copyField: "file" as const,
                          },
                          {
                            label: "ID",
                            value: sessionStats.sessionId,
                            copyField: "id" as const,
                          },
                        ]
                        const messageRows = [
                          [tr("User"), sessionStats.userMessages.toLocaleString()],
                          [tr("Assistant"), sessionStats.assistantMessages.toLocaleString()],
                          [tr("Tool Calls"), sessionStats.toolCalls.toLocaleString()],
                          [tr("Tool Results"), sessionStats.toolResults.toLocaleString()],
                          [tr("Total"), sessionStats.totalMessages.toLocaleString()],
                        ]
                        const tokenRows = [
                          [tr("Input"), sessionStats.tokens.input.toLocaleString()],
                          [tr("Output"), sessionStats.tokens.output.toLocaleString()],
                          ...(sessionStats.tokens.cacheRead > 0
                            ? [[tr("Cache Read"), sessionStats.tokens.cacheRead.toLocaleString()]]
                            : []),
                          ...(sessionStats.tokens.cacheWrite > 0
                            ? [[tr("Cache Write"), sessionStats.tokens.cacheWrite.toLocaleString()]]
                            : []),
                          [tr("Total"), sessionStats.tokens.total.toLocaleString()],
                        ]
                        const ctx = contextUsage ?? sessionStats.contextUsage
                        const formatCompact = (n: number) =>
                          n >= 1_000_000
                            ? `${(n / 1_000_000).toFixed(1)}M`
                            : n >= 1000
                              ? `${(n / 1000).toFixed(0)}k`
                              : String(n)
                        const extraTokenRows = [
                          ...(sessionStats.cost > 0 ? [["Cost", `$${sessionStats.cost.toFixed(4)}`]] : []),
                          ...(ctx?.contextWindow
                            ? [
                                [
                                  "Context",
                                  `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`,
                                ],
                              ]
                            : []),
                        ]
                        const section = (
                          title: string,
                          sectionRows: string[][],
                          valueAlign: "left" | "right" = "left",
                          compact = false,
                        ) => (
                          <div {...stylex.props(inlineStyles.inline30)}>
                            <div {...stylex.props(inlineStyles.inline31)}>{title}</div>
                            <div
                              {...stylex.props(inlineStyles.inline32)}
                              style={{
                                gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                                columnGap: compact ? 14 : 12,
                                justifyContent: compact ? "start" : undefined,
                              }}
                            >
                              {sectionRows.map(([label, value]) => (
                                <div key={`${title}:${label}`} {...stylex.props(inlineStyles.inline33)}>
                                  <div {...stylex.props(inlineStyles.inline34)}>{label}</div>
                                  <div
                                    {...stylex.props(inlineStyles.inline35)}
                                    style={{
                                      overflowWrap: compact ? "normal" : "anywhere",
                                      textAlign: valueAlign,
                                      whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                    }}
                                  >
                                    {value}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                        const copyButton = (field: SessionCopyField, value: string) => {
                          const copied = copiedSessionField === field
                          return (
                            <button
                              type="button"
                              title={copied ? "Copied" : `Copy ${field === "file" ? "file path" : "session ID"}`}
                              onClick={() => handleCopySessionField(field, value)}
                              {...stylex.props(inlineStyles.inline36)}
                              style={{
                                color: copied ? "var(--accent)" : "var(--text-dim)",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "var(--accent)"
                                e.currentTarget.style.borderColor = "var(--accent)"
                                e.currentTarget.style.background = "var(--bg-hover)"
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)"
                                e.currentTarget.style.borderColor = "var(--border)"
                                e.currentTarget.style.background = "transparent"
                              }}
                            >
                              {copied ? (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              )}
                            </button>
                          )
                        }
                        const sessionInfoSection = (
                          <div {...stylex.props(inlineStyles.inline37)}>
                            <div {...stylex.props(inlineStyles.inline38)}>{tr("Session Info")}</div>
                            <div {...stylex.props(inlineStyles.inline39)}>
                              {sessionRows.map((row) => (
                                <div key={`session-info:${row.label}`} {...stylex.props(inlineStyles.inline40)}>
                                  <div {...stylex.props(inlineStyles.inline41)}>{row.label}</div>
                                  <div {...stylex.props(inlineStyles.inline42)}>{row.value}</div>
                                  <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                        return (
                          <div
                            {...stylex.props(inlineStyles.inline43)}
                            style={{
                              gridTemplateColumns: isMobile
                                ? "1fr"
                                : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                              gap: isMobile ? 16 : 24,
                            }}
                          >
                            {sessionInfoSection}
                            {section(tr("Messages"), messageRows)}
                            {section(tr("Tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                          </div>
                        )
                      })()
                    ) : (
                      <div {...stylex.props(inlineStyles.inline44)}>
                        {tr("Send a message or run /session to load session info")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Chat content */}
          <div {...stylex.props(inlineStyles.inline45)}>
            {showChat ? (
              <ChatWindow
                session={selectedSession}
                sessionRefreshKey={sessionRefreshKey}
                inputFocusEpoch={inputFocusEpoch}
                onAgentEnd={handleAgentEnd}
                onSessionIndexChanged={handleSessionIndexChanged}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={handleBranchDataChange}
                onSystemPromptChange={handleSystemPromptChange}
                onSessionStatsChange={handleSessionStatsChange}
                onSessionStatsPanelOpen={openSessionStatsPanel}
                onContextUsageChange={handleContextUsageChange}
                onWeixinStatusChange={handleWeixinStatusChange}
                onOpenFile={handleOpenLinkedFile}
                onOpenModels={() => setSettingsSurface({ kind: "models" })}
                onOpenSkills={() => setSettingsSurface({ kind: "skills" })}
                skillsCount={skillsCount}
              />
            ) : creatingSessionCwd !== null ? (
              <div {...stylex.props(styles.pendingSession)}>
                <div {...stylex.props(styles.chatColumn)}>
                  <ChatInput
                    onSend={() => undefined}
                    onAbort={() => undefined}
                    isStreaming={false}
                    sessionLoading
                    cwd={creatingSessionCwd}
                  />
                </div>
              </div>
            ) : createSessionError !== null ? (
              <div {...stylex.props(styles.createSessionError)}>{createSessionError}</div>
            ) : showPlaceholder ? (
              activeCwd ? (
                <div {...stylex.props(inlineStyles.inline46)}>{tr("Select a session from the sidebar")}</div>
              ) : (
                <div {...stylex.props(inlineStyles.inline47)}>
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    {...stylex.props(inlineStyles.inline48)}
                  >
                    <line x1="20" y1="12" x2="4" y2="12" />
                    <polyline points="10 6 4 12 10 18" />
                  </svg>
                  <div>
                    <div {...stylex.props(inlineStyles.inline49)}>{tr("Get Started")}</div>
                    <div {...stylex.props(inlineStyles.inline50)}>
                      <span {...stylex.props(inlineStyles.inline51)}>1.</span>
                      {tr("Select a project directory from the sidebar")}
                      <br />
                      <span {...stylex.props(inlineStyles.inline52)}>2.</span>
                      {tr("Add models via the Models button at the bottom")}
                    </div>
                  </div>
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
      {/* Extension launcher — the single plugin-management entry point. */}
      <button
        onClick={() => setSettingsSurface({ kind: "plugins" })}
        title={tr("Plugins")}
        aria-label={tr("Plugins")}
        {...stylex.props(inlineStyles.inline58)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
        </svg>
        <span {...stylex.props(inlineStyles.extensionCount)}>{activeExtensionCount}</span>
      </button>
      {resourceManagerOpen && managementCwd && (
        <div {...stylex.props(inlineStyles.modalBackdrop)} onMouseDown={() => setResourceManagerOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={tr("Resource manager")}
            {...stylex.props(inlineStyles.resourceDialog)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header {...stylex.props(inlineStyles.modalHeader)}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <strong>{tr("Resource manager")}</strong>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                  {managementCwd}
                </span>
              </div>
              <button type="button" onClick={() => setResourceManagerOpen(false)} aria-label={tr("Close")}>
                ×
              </button>
            </header>
            <div {...stylex.props(inlineStyles.resourceWorkspace)}>
              <aside {...stylex.props(inlineStyles.resourceTree)}>
                <FileExplorer
                  cwd={managementCwd}
                  onOpenFile={handleOpenFile}
                  refreshKey={explorerRefreshKey}
                  onAtMention={handleAtMention}
                />
              </aside>
              <div {...stylex.props(inlineStyles.resourceViewer)}>
                <div {...stylex.props(inlineStyles.resourceTabs)}>
                  <TabBar
                    tabs={fileTabs}
                    activeTabId={activeFileTabId ?? ""}
                    onSelectTab={setActiveFileTabId}
                    onCloseTab={handleCloseFileTab}
                  />
                </div>
                <div {...stylex.props(inlineStyles.resourceContent)}>
                  {activeFileTab?.filePath ? (
                    <Suspense fallback={null}>
                      <FileViewer
                        filePath={activeFileTab.filePath}
                        cwd={managementCwd}
                        sourceSessionId={activeFileTab.sourceSessionId}
                      />
                    </Suspense>
                  ) : (
                    <div {...stylex.props(inlineStyles.inline57)}>{tr("Select a file to preview")}</div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
      <Suspense fallback={null}>
        {settingsSurface?.kind === "models" && (
          <ModelsConfig
            onClose={() => {
              setSettingsSurface(null)
              setModelsRefreshKey((k) => k + 1)
            }}
          />
        )}
        {settingsSurface?.kind === "skills" && (activeCwd ?? selectedSession?.cwd) && (
          <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd)!} onClose={() => setSettingsSurface(null)} />
        )}
        {settingsSurface?.kind === "plugins" && (
          <div {...stylex.props(inlineStyles.modalBackdrop)} onMouseDown={() => setSettingsSurface(null)}>
            <section {...stylex.props(inlineStyles.extensionDialog)} onMouseDown={(event) => event.stopPropagation()}>
              <button
                type="button"
                onClick={() => setSettingsSurface(null)}
                aria-label={tr("Close")}
                {...stylex.props(inlineStyles.modalClose)}
              >
                ×
              </button>
              <PluginsConfig
                presentation="page"
                cwd={null}
                sessionId={null}
                projectCwds={[...new Set(sessionCollection.map((session) => session.cwd))].sort()}
                initialPackageName={settingsSurface.initialPackageName}
                chromeHealth={chromeExtensionHealth}
                weixinStatus={weixinStatus}
                onClose={() => setSettingsSurface(null)}
                openablePackageNames={new Set(extensionCatalog?.groups.map((group) => group.item.packageName) ?? [])}
                onOpenPackage={(packageName) => {
                  const surface = extensionCatalog?.groups.find((group) => group.item.packageName === packageName)
                  if (!surface) return
                  setSettingsSurface(null)
                  void navigate({ to: "/extensions/$surfaceId", params: { surfaceId: surface.item.surfaceId } })
                }}
                onReloaded={() => setSessionRefreshKey((key) => key + 1)}
              />
            </section>
          </div>
        )}
        {settingsSurface?.kind === "general" && (
          <div {...stylex.props(inlineStyles.modalBackdrop)} onMouseDown={() => setSettingsSurface(null)}>
            <section {...stylex.props(inlineStyles.settingsDialog)} onMouseDown={(event) => event.stopPropagation()}>
              <header {...stylex.props(inlineStyles.modalHeader)}>
                <strong>{tr("Settings")}</strong>
                <button type="button" onClick={() => setSettingsSurface(null)} aria-label={tr("Close")}>
                  ×
                </button>
              </header>
              <div {...stylex.props(inlineStyles.settingsBody)}>
                <div {...stylex.props(inlineStyles.settingRow)}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <strong>{tr("Completion sound")}</strong>
                    <span>{tr("Play a sound when the agent finishes")}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preferences.soundEnabled}
                    onClick={() =>
                      updatePreferences((current) => ({ ...current, soundEnabled: !current.soundEnabled }))
                    }
                    {...stylex.props(inlineStyles.settingsToggle)}
                    style={{ background: preferences.soundEnabled ? "var(--accent)" : "var(--border)" }}
                  >
                    <i
                      style={{
                        background: "white",
                        borderRadius: "50%",
                        display: "block",
                        height: 20,
                        transition: "transform .15s",
                        width: 20,
                        transform: preferences.soundEnabled ? "translateX(16px)" : "translateX(0)",
                      }}
                    />
                  </button>
                </div>
                <div {...stylex.props(inlineStyles.systemPromptSetting)}>
                  <strong>{tr("System prompt")}</strong>
                  <pre
                    style={{
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      lineHeight: 1.55,
                      margin: 0,
                      maxHeight: 480,
                      overflow: "auto",
                      overflowWrap: "anywhere",
                      padding: 12,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {systemPrompt || tr("Send a message to load the system prompt")}
                  </pre>
                </div>
              </div>
            </section>
          </div>
        )}
      </Suspense>
    </>
  )
}
const styles = stylex.create({
  pendingSession: {
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    justifyContent: "center",
    overflowY: "auto",
    paddingBlock: 32,
    paddingInline: 16,
  },
  chatColumn: {
    maxWidth: 820,
    width: "100%",
  },
  createSessionError: {
    alignItems: "center",
    color: "oklch(70.4% 0.191 22.216)",
    display: "flex",
    height: "100%",
    justifyContent: "center",
  },
})
const inlineStyles = stylex.create({
  inline1: {
    padding: "8px",
    flexShrink: 0,
    display: "flex",
    justifyContent: "space-between",
    gap: 4,
  },
  inline2: {
    position: "relative",
    display: "inline-flex",
  },
  inline3: {
    position: "absolute",
    top: -4,
    right: -5,
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#ef4444",
    boxShadow: "0 0 0 2px var(--bg-panel)",
  },
  inline4: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 32,
    padding: 0,
    background: "none",
    border: "none",
    borderRadius: 9,
    color: "var(--text-muted)",
    fontSize: 12,
    transition: "background 0.12s, color 0.12s",
  },
  inline5: {
    display: "flex",
    height: "100dvh",
    overflow: "hidden",
    background: "var(--bg)",
  },
  inline6: {
    display: { "@media (min-width: 641px)": "none" },
    position: "fixed",
    inset: 0,
    zIndex: 199,
    background: "rgba(0,0,0,0.4)",
    transition: "opacity 0.25s ease",
  },
  inline7: {
    background: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    zIndex: 200,
  },
  inline8: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: 0,
  },
  inline9: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    borderBottom: "1px solid var(--border)",
    height: 36,
    background: "var(--bg-panel)",
  },
  inline10: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    background: "none",
    border: "none",
    borderRight: "1px solid var(--border)",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "color 0.12s",
  },
  inline11: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    background: "none",
    border: "none",
    borderRight: "1px solid var(--border)",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "color 0.12s",
  },
  inline12: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44,
    height: 36,
    padding: "0 8px",
    background: "none",
    border: "none",
    borderRight: "1px solid var(--border)",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    transition: "color 0.12s",
  },
  inline13: {
    display: "flex",
    alignItems: "stretch",
    height: "100%",
    order: 3,
  },
  inline14: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "100%",
    padding: "0 12px",
    background: "none",
    border: "none",
    borderTop: "2px solid transparent",
    borderRight: "1px solid var(--border)",
    flexShrink: 0,
    fontSize: 11,
    whiteSpace: "nowrap",
    transition: "color 0.1s, background 0.1s, opacity 0.1s",
  },
  inline15: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    borderRadius: 5,
    background: "transparent",
    flexShrink: 0,
  },
  inline16: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "100%",
    padding: "0 12px",
    border: "none",
    borderRight: "1px solid var(--border)",
    cursor: "pointer",
    fontSize: 11,
    whiteSpace: "nowrap",
    transition: "color 0.1s, background 0.1s",
  },
  inline17: {
    flexShrink: 0,
  },
  inline18: {
    marginLeft: "auto",
    order: 2,
    display: "flex",
    alignItems: "center",
    gap: 10,
    paddingLeft: 12,
    height: "100%",
    border: "none",
    fontSize: 11,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
    cursor: "pointer",
    fontVariantNumeric: "tabular-nums",
    transition: "color 0.1s, background 0.1s",
  },
  inline19: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline20: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline21: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline22: {
    display: "flex",
    alignItems: "center",
    color: "var(--text)",
    fontWeight: 500,
  },
  inline23: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  inline24: {
    position: "fixed",
    overflowY: "auto",
    zIndex: 500,
  },
  inline25: {
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
  },
  inline26: {
    maxHeight: "min(600px, 75vh)",
    overflowY: "auto",
    padding: "12px 16px",
    color: "var(--text-muted)",
    fontSize: 12,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    fontFamily: "var(--font-mono)",
  },
  inline27: {
    padding: "10px 16px",
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
  inline28: {
    padding: "10px 16px",
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
  inline29: {
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
    padding: "12px 16px",
  },
  inline30: {
    minWidth: 0,
  },
  inline31: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 6,
  },
  inline32: {
    display: "grid",
    rowGap: 4,
  },
  inline33: {
    display: "contents",
  },
  inline34: {
    color: "var(--text-dim)",
    whiteSpace: "nowrap",
  },
  inline35: {
    color: "var(--text-muted)",
    minWidth: 0,
  },
  inline36: {
    alignSelf: "start",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    marginTop: -2,
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 4,
    cursor: "pointer",
    flex: "0 0 auto",
    transition: "color 0.12s, border-color 0.12s, background 0.12s",
  },
  inline37: {
    minWidth: 0,
  },
  inline38: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 6,
  },
  inline39: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    columnGap: 12,
    rowGap: 8,
    alignItems: "start",
  },
  inline40: {
    display: "contents",
  },
  inline41: {
    color: "var(--text-dim)",
    whiteSpace: "nowrap",
  },
  inline42: {
    color: "var(--text-muted)",
    minWidth: 0,
    overflowWrap: "anywhere",
    wordBreak: "break-word",
    whiteSpace: "normal",
  },
  inline43: {
    display: "grid",
    fontSize: 12,
    lineHeight: 1.5,
    fontFamily: "var(--font-mono)",
  },
  inline44: {
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
  },
  inline45: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  inline46: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-muted)",
    fontSize: 15,
  },
  inline47: {
    position: "absolute",
    top: 12,
    left: 12,
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    userSelect: "none",
    pointerEvents: "none",
  },
  inline48: {
    opacity: 0.7,
    flexShrink: 0,
  },
  inline49: {
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 8,
  },
  inline50: {
    fontSize: 12,
    color: "var(--text-muted)",
    lineHeight: 1.8,
  },
  inline51: {
    color: "var(--text-dim)",
    marginRight: 6,
  },
  inline52: {
    color: "var(--text-dim)",
    marginRight: 6,
  },
  inline53: {
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--border)",
    background: "var(--bg)",
  },
  inline54: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    height: 36,
  },
  inline55: {
    flex: 1,
    overflow: "hidden",
  },
  inline56: {
    flex: 1,
    overflow: "hidden",
  },
  inline57: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-dim)",
    fontSize: 12,
  },
  inline58: {
    position: "fixed",
    top: 0,
    right: 0,
    zIndex: 300,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    background: "var(--bg-panel)",
    border: "none",
    borderLeft: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    cursor: "pointer",
    transition: "color 0.12s",
  },
  extensionCount: {
    alignItems: "center",
    backgroundColor: "var(--accent)",
    borderRadius: 8,
    color: "white",
    display: "flex",
    fontSize: 9,
    fontWeight: 700,
    height: 15,
    justifyContent: "center",
    minWidth: 15,
    paddingInline: 3,
    position: "absolute",
    right: 2,
    top: 2,
  },
  copyDebug: {
    backgroundColor: "var(--accent)",
    border: "none",
    borderRadius: 6,
    color: "white",
    cursor: "pointer",
    fontSize: 11,
    paddingBlock: 6,
    paddingInline: 10,
    position: "absolute",
    right: 14,
    top: 10,
    zIndex: 2,
  },
  modalBackdrop: {
    alignItems: "center",
    backdropFilter: "blur(4px)",
    backgroundColor: "rgba(0, 0, 0, 0.42)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    padding: { default: 26, "@media (max-width: 720px)": 0 },
    position: "fixed",
    zIndex: 700,
  },
  resourceDialog: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: { default: 14, "@media (max-width: 720px)": 0 },
    boxShadow: "0 24px 80px rgba(0,0,0,.28)",
    display: "grid",
    gridTemplateRows: "58px minmax(0, 1fr)",
    height: { default: "min(860px, calc(100dvh - 52px))", "@media (max-width: 720px)": "100dvh" },
    maxWidth: 1440,
    overflow: "hidden",
    width: { default: "min(1440px, calc(100vw - 52px))", "@media (max-width: 720px)": "100vw" },
  },
  extensionDialog: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: { default: 14, "@media (max-width: 720px)": 0 },
    boxShadow: "0 24px 80px rgba(0,0,0,.28)",
    height: { default: "min(860px, calc(100dvh - 52px))", "@media (max-width: 720px)": "100dvh" },
    maxWidth: 1180,
    overflow: "hidden",
    position: "relative",
    width: { default: "min(1180px, calc(100vw - 52px))", "@media (max-width: 720px)": "100vw" },
  },
  modalHeader: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    minWidth: 0,
    paddingInline: 18,
  },
  resourceWorkspace: {
    display: "grid",
    gridTemplateColumns: { default: "260px minmax(0, 1fr)", "@media (max-width: 720px)": "140px minmax(0, 1fr)" },
    minHeight: 0,
  },
  resourceTree: { borderRight: "1px solid var(--border)", minHeight: 0, overflow: "auto" },
  resourceViewer: { display: "grid", gridTemplateRows: "38px minmax(0, 1fr)", minHeight: 0, minWidth: 0 },
  resourceTabs: { borderBottom: "1px solid var(--border)", minWidth: 0, overflow: "hidden" },
  resourceContent: { minHeight: 0, overflow: "auto" },
  modalClose: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    fontSize: 18,
    height: 30,
    justifyContent: "center",
    position: "absolute",
    right: 14,
    top: 14,
    width: 30,
    zIndex: 4,
  },
  settingsDialog: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "0 24px 80px rgba(0,0,0,.28)",
    display: "grid",
    gridTemplateRows: "54px auto",
    maxHeight: "min(700px, calc(100dvh - 40px))",
    maxWidth: 680,
    overflow: "hidden",
    width: "min(680px, calc(100vw - 32px))",
  },
  settingsBody: { display: "flex", flexDirection: "column", gap: 18, overflow: "auto", padding: 20 },
  settingRow: { alignItems: "center", display: "flex", justifyContent: "space-between" },
  settingsToggle: {
    backgroundColor: "var(--border)",
    border: "none",
    borderRadius: 12,
    cursor: "pointer",
    height: 24,
    padding: 2,
    width: 42,
  },
  systemPromptSetting: { display: "flex", flexDirection: "column", gap: 8 },
})
