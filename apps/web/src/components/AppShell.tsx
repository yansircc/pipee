import { Suspense, useState, useCallback, useRef, useEffect, useMemo } from "react"
import * as stylex from "@stylexjs/stylex"
import { Effect, Schedule } from "effect"
import { getRouteApi } from "@tanstack/react-router"
import { SessionSidebar } from "./SessionSidebar"
import { ChatWindow } from "./ChatWindow"
import { WorkspaceFinder } from "./WorkspaceFinder"
import { ApplicationSettingsPopover } from "./ApplicationSettingsPopover"
import { ExtensionDrawer } from "./ExtensionDrawer"
import { SessionInspector, type SessionContextUsage, type SystemPromptState } from "./SessionInspector"
import { readWebSurfaceCatalogs } from "./ExtensionShell"
import { BranchNavigator } from "./BranchNavigator"
import { useIsMobile } from "@/hooks/useIsMobile"
import { getFileName } from "@/lib/file-paths"
import { buildAtMentionText } from "@/lib/file-fuzzy"
import type { SessionBranchNode, SessionInfo, SessionStats, WeixinStatusProjection } from "@/api/contract"
import { ChatInput, type ChatInputHandle } from "./ChatInput"
import { useI18n } from "@/lib/i18n"
import { withApi, apiUrls, runApi, runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { ModelsConfig, SkillsConfig } from "@/browser/code-split"
import { sessionController } from "@/features/session/session-controller"
import { DEFAULT_TOOL_PRESET, getToolNamesForPreset } from "@/lib/tool-presets"
import { probeChromeExtension, type ChromeExtensionHealth } from "@/lib/chrome-extension-installation"
import type { ExtensionCatalogState } from "@/lib/web-surface-catalog-group"
import { useApplicationHotkeys } from "@/ui/interaction/Hotkeys"
type SelectedFinderFile = {
  readonly filePath: string
  readonly sourceSessionId?: string | null
}
type SettingsSurface =
  | { readonly kind: "general" }
  | { readonly kind: "models" }
  | { readonly kind: "skills" }
  | { readonly initialPackageName?: string; readonly kind: "plugins" }
  | null
const indexRoute = getRouteApi("/")
export function AppShell() {
  const { t: tr } = useI18n()
  const navigate = indexRoute.useNavigate()
  const search = indexRoute.useSearch()
  const isMobile = useIsMobile()
  const [sessionCollection, setSessionCollection] = useState<SessionInfo[]>([])
  const selectedSession = useMemo(
    () =>
      search.session === undefined
        ? null
        : (sessionCollection.find((candidate) => candidate.id === search.session) ?? null),
    [search.session, sessionCollection],
  )
  const selectedSessionId = selectedSession?.id ?? null
  const [creatingSessionCwd, setCreatingSessionCwd] = useState<string | null>(null)
  const [createSessionError, setCreateSessionError] = useState<string | null>(null)
  const [inputFocusEpoch, setInputFocusEpoch] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const sessionProjectionOwner = selectedSession === null ? "none" : `session:${selectedSession.id}`
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0)
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0)
  const [settingsSurface, setSettingsSurface] = useState<SettingsSurface>(null)
  const [resourceManagerOpen, setResourceManagerOpen] = useState(false)
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
  const [systemPromptState, setSystemPromptState] = useState<SystemPromptState>({ status: "none" })
  const handleSystemPromptChange = useCallback((state: Exclude<SystemPromptState, { status: "none" }>) => {
    setSystemPromptState(state)
  }, [])
  useEffect(() => {
    setSystemPromptState(
      selectedSessionId === null ? { status: "none" } : { sessionId: selectedSessionId, status: "loading" },
    )
  }, [selectedSessionId])

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const handleSessionStatsChange = useCallback((stats: SessionStats | null) => {
    setSessionStats(stats)
  }, [])
  const [weixinStatus, setWeixinStatus] = useState<WeixinStatusProjection | undefined>(undefined)
  const handleWeixinStatusChange = useCallback((status: WeixinStatusProjection) => {
    setWeixinStatus(status)
  }, [])
  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<SessionContextUsage | null>(null)
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
      const width = isMobile ? Math.max(0, rect.width - 14) : Math.min(370, Math.max(0, rect.width - 24))
      setTopPanelPos({
        top: rect.height,
        left: isMobile ? 7 : rect.width - width - 48,
        width,
      })
    }
    return runBrowser(
      BrowserPlatform.pipe(Effect.flatMap((browser) => browser.observeResize([topBarRef.current!], update))),
      {
        onSuccess: () => undefined,
      },
    )
  }, [activeTopPanel, isMobile])
  useEffect(() => {
    if (activeTopPanel !== "session") return
    const close = (event: MouseEvent) => {
      if (!topBarRef.current?.contains(event.target as Node)) setActiveTopPanel(null)
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.onDocumentMouseDown(close))), {
      onSuccess: () => undefined,
    })
  }, [activeTopPanel])
  // Finder owns one selected file; workspace APIs remain the only content source.
  const [selectedFinderFile, setSelectedFinderFile] = useState<SelectedFinderFile | null>(null)
  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir))
  }, [])
  const [initialSessionId] = useState<string | null>(() => search.session ?? null)
  const [activeCwd, setActiveCwd] = useState<string | null>(null)
  const managementCwd = activeCwd ?? selectedSession?.cwd ?? null
  const openFinder = useCallback(() => {
    setSettingsSurface(null)
    setActiveTopPanel(null)
    setResourceManagerOpen(true)
  }, [])
  const openSettingsSurface = useCallback((surface: Exclude<SettingsSurface, null>) => {
    setResourceManagerOpen(false)
    setActiveTopPanel(null)
    setSettingsSurface(surface)
  }, [])
  useApplicationHotkeys(
    [
      {
        hotkey: "Mod+Shift+E",
        callback: openFinder,
        options: { enabled: managementCwd !== null, preventDefault: true },
      },
      {
        hotkey: "Escape",
        callback: () => {
          if (settingsSurface !== null) setSettingsSurface(null)
          else if (resourceManagerOpen) setResourceManagerOpen(false)
          else if (activeTopPanel !== null) setActiveTopPanel(null)
          else if (isMobile && sidebarOpen) setSidebarOpen(false)
        },
        options: {
          enabled:
            settingsSurface !== null || resourceManagerOpen || activeTopPanel !== null || (isMobile && sidebarOpen),
          preventDefault: true,
        },
      },
    ],
    { eventType: "keydown" },
  )
  useEffect(() => {
    setSelectedFinderFile(null)
  }, [managementCwd])
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
      setSystemPromptState({ status: "none" })
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
      setSystemPromptState({ sessionId: session.id, status: "loading" })
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
      setSystemPromptState({ status: "none" })
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
        setSystemPromptState({ status: "none" })
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
    (filePath: string, _fileName: string, sourceSessionId?: string | null) => {
      setSelectedFinderFile({ filePath, sourceSessionId })
      openFinder()
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false)
    },
    [isMobile, openFinder],
  )
  const handleOpenLinkedFile = useCallback(
    (filePath: string) => {
      handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null)
    },
    [handleOpenFile, selectedSession?.id],
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
  const selectedSessionTitle = selectedSession
    ? selectedSession.name || selectedSession.firstMessage.slice(0, 64) || selectedSession.id.slice(0, 12)
    : tr("Pi Agent Web")
  const selectedSessionContext = selectedSession
    ? `${getFileName(selectedSession.cwd)} · ${selectedSession.worktreeBranch ?? "main"}`
    : managementCwd
      ? getFileName(managementCwd)
      : ""
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat
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
      onOpenExplorer={openFinder}
      onOpenSettings={() =>
        settingsSurface?.kind === "general" ? setSettingsSurface(null) : openSettingsSurface({ kind: "general" })
      }
      settingsOpen={settingsSurface?.kind === "general"}
    />
  )
  return (
    <>
      <style>{`
      @keyframes session-info-pop {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes extension-drawer-in {
        from { opacity: 0; transform: translateX(36px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .extension-drawer {
        animation: extension-drawer-in 200ms ease-out both;
      }
      .session-info-popover {
        transform-origin: top right;
        animation: session-info-pop 140ms ease-out both;
      }
      .debug-control > span,
      .debug-control > svg:not(.debug-icon) {
        display: none !important;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover { animation: none; }
        .extension-drawer { animation: none; }
      }
      @media (max-width: 760px) {
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
          aria-hidden={!sidebarOpen}
          className={`${stylex.props(inlineStyles.inline6).className} sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          onClick={() => setSidebarOpen(false)}
          style={{
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? "auto" : "none",
          }}
        />

        {/* Left sidebar */}
        <div
          aria-hidden={!sidebarOpen}
          className={`${stylex.props(inlineStyles.inline7).className} sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
          inert={sidebarOpen ? undefined : true}
        >
          {sidebarContent}
        </div>

        {/* Center: chat */}
        <div {...stylex.props(inlineStyles.inline8)}>
          {/* Top bar with sidebar toggle */}
          <div ref={topBarRef} {...stylex.props(inlineStyles.inline9)}>
            <div {...stylex.props(inlineStyles.topbarTitleArea)}>
              <button
                onClick={handleSidebarToggle}
                title={tr(sidebarOpen ? "Hide sidebar" : "Show sidebar")}
                aria-label={tr(sidebarOpen ? "Hide sidebar" : "Show sidebar")}
                {...stylex.props(inlineStyles.inline10)}
              >
                <svg
                  width="15"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <line x1="9" y1="4" x2="9" y2="20" />
                </svg>
              </button>
              <div {...stylex.props(inlineStyles.topbarIdentity)}>
                <strong {...stylex.props(inlineStyles.topbarTitle)}>{selectedSessionTitle}</strong>
                {selectedSessionContext && (
                  <small {...stylex.props(inlineStyles.topbarContext)}>{selectedSessionContext}</small>
                )}
              </div>
              {showChat && (
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
              )}
            </div>
            <div {...stylex.props(inlineStyles.topbarActions)}>
              {showChat && (
                <button
                  onClick={handleExportSession}
                  title={tr("Export HTML")}
                  aria-label={tr("Export HTML")}
                  {...stylex.props(inlineStyles.topbarIconButton)}
                >
                  <svg width="15" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M12 3v12m-4-4 4 4 4-4M4 20h16" />
                  </svg>
                </button>
              )}
              {showChat && (
                <button
                  type="button"
                  onClick={() => toggleTopPanel("session")}
                  title={tr("Debug information")}
                  aria-label={tr("Debug information")}
                  aria-pressed={activeTopPanel === "session"}
                  {...stylex.props(
                    inlineStyles.topbarIconButton,
                    activeTopPanel === "session" && inlineStyles.topbarIconButtonActive,
                  )}
                >
                  <svg width="15" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M8 8h8v8a4 4 0 0 1-8 0Z" />
                    <path d="M9 8V6a3 3 0 0 1 6 0v2M4 13h4m8 0h4M5 7l3 2m8 0 3-2M5 19l3-2m8 0 3 2" />
                  </svg>
                </button>
              )}
              <button
                onClick={() => openSettingsSurface({ kind: "plugins" })}
                title={tr("Plugins")}
                aria-label={tr("Plugins")}
                {...stylex.props(inlineStyles.inline58)}
              >
                <svg width="15" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M8 3h3a2 2 0 1 1 4 0h3a2 2 0 0 1 2 2v4h-3a2 2 0 1 0 0 4h3v4a2 2 0 0 1-2 2h-4v-3a2 2 0 1 0-4 0v3H6a2 2 0 0 1-2-2v-4h3a2 2 0 1 0 0-4H4V5a2 2 0 0 1 2-2Z" />
                </svg>
                <span {...stylex.props(inlineStyles.extensionCount)}>{activeExtensionCount}</span>
              </button>
            </div>
            {/* Top panel dropdown — shared, only one active at a time */}
            {activeTopPanel && topPanelPos && (
              <div
                {...stylex.props(inlineStyles.inline24)}
                style={{
                  top: activeTopPanel === "session" ? Math.max(0, topPanelPos.top - 14) : topPanelPos.top,
                  left: topPanelPos.left,
                  width: topPanelPos.width,
                  maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
                }}
              >
                {activeTopPanel === "session" && (
                  <SessionInspector
                    contextUsage={contextUsage}
                    cwd={managementCwd}
                    selectedSessionId={selectedSessionId}
                    sessionStats={sessionStats}
                    systemPromptState={systemPromptState}
                    weixinStatus={weixinStatus}
                  />
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
                onOpenModels={() => openSettingsSurface({ kind: "models" })}
                onOpenSkills={() => openSettingsSurface({ kind: "skills" })}
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
      {resourceManagerOpen && managementCwd && (
        <WorkspaceFinder
          cwd={managementCwd}
          onAtMention={handleAtMention}
          onClose={() => setResourceManagerOpen(false)}
          onOpenFile={handleOpenFile}
          refreshKey={explorerRefreshKey}
          selectedFile={selectedFinderFile}
        />
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
          <ExtensionDrawer
            chromeHealth={chromeExtensionHealth}
            initialPackageName={settingsSurface.initialPackageName}
            onClose={() => setSettingsSurface(null)}
            onOpenPackage={(packageName) => {
              const surface = extensionCatalog?.groups.find((group) => group.item.packageName === packageName)
              if (!surface) return
              setSettingsSurface(null)
              void navigate({ to: "/extensions/$surfaceId", params: { surfaceId: surface.item.surfaceId } })
            }}
            onReloaded={() => setSessionRefreshKey((key) => key + 1)}
            openablePackageNames={new Set(extensionCatalog?.groups.map((group) => group.item.packageName) ?? [])}
            projectCwds={[...new Set(sessionCollection.map((session) => session.cwd))].sort()}
            weixinStatus={weixinStatus}
          />
        )}
        {settingsSurface?.kind === "general" && <ApplicationSettingsPopover onClose={() => setSettingsSurface(null)} />}
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
    display: { "@media (min-width: 761px)": "none" },
    position: "fixed",
    inset: 0,
    zIndex: 199,
    background: "rgba(0,0,0,0.4)",
    backdropFilter: "blur(2px)",
    transition: "opacity var(--motion-surface) ease",
  },
  inline7: {
    background: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    zIndex: 200,
    transition: "transform var(--motion-surface) cubic-bezier(.2,.8,.2,1), opacity var(--motion-fast) ease",
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
    justifyContent: "space-between",
    flexShrink: 0,
    borderBottom: "1px solid var(--border)",
    height: "var(--topbar-height)",
    padding: "0 15px 0 12px",
    background: "color-mix(in srgb, var(--bg) 91%, transparent)",
    backdropFilter: "blur(18px)",
    position: "relative",
    zIndex: 6,
  },
  inline10: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 33,
    height: 33,
    padding: 0,
    background: "none",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "color var(--motion-fast), background var(--motion-fast)",
    ":hover": { color: "var(--text)", background: "var(--bg-hover)" },
  },
  topbarTitleArea: {
    alignItems: "center",
    display: "flex",
    gap: 7,
    minWidth: 0,
  },
  topbarIdentity: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    maxWidth: { default: 420, "@media (max-width: 760px)": 220 },
  },
  topbarTitle: {
    color: "var(--text)",
    fontSize: 13,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  topbarContext: {
    color: "var(--text-dim)",
    display: { default: "block", "@media (max-width: 760px)": "none" },
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    lineHeight: "13px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  topbarActions: {
    alignItems: "center",
    display: "flex",
    gap: 7,
    flexShrink: 0,
  },
  topbarIconButton: {
    alignItems: "center",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    height: 33,
    justifyContent: "center",
    padding: 0,
    width: 33,
    ":hover": { background: "var(--bg-hover)", color: "var(--text)" },
  },
  topbarIconButtonActive: {
    background: "var(--bg-selected)",
    color: "var(--text)",
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
    zIndex: "var(--layer-popover)",
    marginTop: 7,
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow-surface)",
    maxHeight: "calc(100dvh - var(--topbar-height) - 14px)",
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
  inline58: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    padding: 0,
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    cursor: "pointer",
    transition: "color var(--motion-fast), background var(--motion-fast)",
    ":hover": { background: "var(--bg-hover)", color: "var(--text)" },
  },
  extensionCount: {
    alignItems: "center",
    backgroundColor: "var(--accent)",
    borderRadius: 9,
    color: "white",
    display: "flex",
    fontSize: 9,
    fontWeight: 700,
    height: 15,
    justifyContent: "center",
    minWidth: 15,
    paddingInline: 3,
    position: "absolute",
    right: -3,
    top: -2,
    border: "2px solid var(--bg)",
  },
})
