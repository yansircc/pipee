import * as stylex from "@stylexjs/stylex"
import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react"
import { DateTime, Duration, Effect, Option } from "effect"
import type { SessionInfo } from "@/api/contract"
import { useI18n, type Locale } from "@/lib/i18n"
import { withApi, runApi, runBrowser, type Cancel } from "@/browser/api-client"
import { useBrowserPreferences } from "@/browser/preferences-react"
import { after, observeCurrentTime } from "@/browser/timing"
import { BrowserPlatform } from "@/browser/browser-platform"
import { observeRunningSessions } from "@/features/session/session-controller"
interface Props {
  selectedSessionId: string | null
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void
  onNewSession?: (cwd: string) => void
  newSessionPending?: boolean
  initialSessionId?: string | null
  onInitialRestoreDone?: () => void
  refreshKey?: number
  onSessionDeleted?: (sessionId: string) => void
  selectedCwd?: string | null
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void
  onOpenExplorer?: () => void
  onOpenSettings?: () => void
  settingsOpen?: boolean
}
interface WorktreeEntry {
  path: string
  branch: string | null
  isMain: boolean
}
interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string
  projectRoot: string
  isGit: boolean
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean
  worktrees: WorktreeEntry[]
}
function formatRelativeTime(dateStr: string, locale: Locale, nowMillis: number): string {
  const parsed = DateTime.make(dateStr)
  if (Option.isNone(parsed)) return dateStr
  const date = parsed.value
  const diff = nowMillis - DateTime.toEpochMillis(date)
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (locale === "zh-CN") {
    if (mins < 1) return "刚刚"
    if (mins < 60) return `${mins} 分钟前`
    if (hours < 24) return `${hours} 小时前`
    if (days < 7) return `${days} 天前`
  } else {
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days < 7) return `${days}d ago`
  }
  return DateTime.formatLocal(date, {
    locale,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
}

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>() // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd
    if (!root) continue
    const prev = latestByRoot.get(root)
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified)
    }
  }
  return [...latestByRoot.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([root]) => root)
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span {...stylex.props(inlineStyles.inline1)}>{text}</span>
    </span>
  )
}
const DROPDOWN_ANIMATION_MS = 140
function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)
  useEffect(() => {
    let cancelFrame: Cancel | undefined
    let cancelDelay: Cancel | undefined
    if (open) {
      setMounted(true)
      setVisible(false)
      cancelFrame = runBrowser(
        Effect.gen(function* () {
          const browser = yield* BrowserPlatform
          yield* browser.nextAnimationFrame
          yield* browser.nextAnimationFrame
          yield* Effect.sync(() => setVisible(true))
        }),
        {
          onSuccess: () => undefined,
        },
      )
    } else {
      setVisible(false)
      cancelDelay = runBrowser(
        after(Duration.millis(DROPDOWN_ANIMATION_MS), () => setMounted(false)),
        {
          onSuccess: () => undefined,
        },
      )
    }
    return () => {
      cancelFrame?.()
      cancelDelay?.()
    }
  }, [open])
  if (!mounted) return null
  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  )
}
interface SessionTreeNode {
  session: SessionInfo
  children: SessionTreeNode[]
}
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>()
  for (const s of sessions) {
    byId.set(s.id, {
      session: s,
      children: [],
    })
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>()
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId)
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id)
    const visited = new Set<string>()
    while (cur) {
      if (visited.has(cur)) return null // cycle guard
      visited.add(cur)
      if (byId.has(cur)) return cur
      cur = parentOf.get(cur)
    }
    return null
  }
  const roots: SessionTreeNode[] = []
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id)
    if (ancestor) {
      byId.get(ancestor)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified))
    nodes.forEach((n) => sort(n.children))
  }
  sort(roots)
  return roots
}
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*"
function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target)
  const iterRef = useRef(0)
  useEffect(() => {
    if (!running) {
      setDisplay(target)
      return
    }
    iterRef.current = 0
    const totalFrames = target.length * 4
    return runBrowser(
      Effect.gen(function* () {
        const browser = yield* BrowserPlatform
        while (iterRef.current < totalFrames) {
          yield* browser.nextAnimationFrame
          yield* Effect.sync(() => {
            iterRef.current += 1
            const progress = iterRef.current / totalFrames
            const resolved = Math.floor(progress * target.length)
            setDisplay(
              target
                .split("")
                .map((char, index) => {
                  if (char === " ") return " "
                  if (index < resolved) return char
                  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
                })
                .join(""),
            )
          })
        }
        yield* Effect.sync(() => setDisplay(target))
      }),
      {
        onSuccess: () => undefined,
      },
    )
  }, [target, running])
  return display
}
function PiAgentTitle() {
  const [showVersion, setShowVersion] = useState(false)
  const [scrambling, setScrambling] = useState(false)
  const scrambleDelayRef = useRef<Cancel | null>(null)
  const revertDelayRef = useRef<Cancel | null>(null)
  const target = showVersion ? `${__APP_VERSION__}p${__PI_VERSION__}` : "Pi Agent Web"
  const display = useScramble(target, scrambling)
  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion)
    setScrambling(true)
    scrambleDelayRef.current?.()
    scrambleDelayRef.current = runBrowser(
      after(Duration.millis((toVersion ? 6 : 8) * 4 * (1000 / 60) + 100), () => setScrambling(false)),
      {
        onSuccess: () => undefined,
      },
    )
  }, [])
  const handleClick = useCallback(() => {
    revertDelayRef.current?.()
    const next = !showVersion
    triggerScramble(next)
    if (next) {
      revertDelayRef.current = runBrowser(
        after("3 seconds", () => triggerScramble(false)),
        {
          onSuccess: () => undefined,
        },
      )
    }
  }, [showVersion, triggerScramble])
  useEffect(
    () => () => {
      scrambleDelayRef.current?.()
      revertDelayRef.current?.()
    },
    [],
  )
  return (
    <div {...stylex.props(inlineStyles.brand)}>
      <span {...stylex.props(inlineStyles.brandMark)}>π</span>
      <button
        onClick={handleClick}
        {...stylex.props(inlineStyles.inline2)}
        style={{ color: showVersion ? "var(--accent)" : "var(--text)" }}
      >
        {display}
      </button>
    </div>
  )
}
export function SessionSidebar({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  newSessionPending = false,
  initialSessionId,
  onInitialRestoreDone,
  refreshKey,
  onSessionDeleted,
  selectedCwd: selectedCwdProp,
  onCwdChange,
  onOpenExplorer,
  onOpenSettings,
  settingsOpen,
}: Props) {
  const { t, locale } = useI18n()
  const { preferences, updatePreferences } = useBrowserPreferences()
  const unreadSessionIds = useMemo(() => new Set(preferences.unreadSessionIds), [preferences.unreadSessionIds])
  const updateUnreadSessionIds = useCallback(
    (update: (current: Set<string>) => Set<string>) => {
      updatePreferences((current) => ({
        ...current,
        unreadSessionIds: [...update(new Set(current.unreadSessionIds))],
      }))
    },
    [updatePreferences],
  )
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null)
  const [homeDir, setHomeDir] = useState<string>("")
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [projectFilter, setProjectFilter] = useState("")
  const [customPathOpen, setCustomPathOpen] = useState(false)
  const [customPathValue, setCustomPathValue] = useState("")
  const [customPathError, setCustomPathError] = useState<string | null>(null)
  const [customPathValidating, setCustomPathValidating] = useState(false)
  const customPathInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null)
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false)
  const [wtNewOpen, setWtNewOpen] = useState(false)
  const [wtNewBranch, setWtNewBranch] = useState("")
  const [wtError, setWtError] = useState<string | null>(null)
  const [wtBusy, setWtBusy] = useState(false)
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null)
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null)
  const wtDropdownRef = useRef<HTMLDivElement>(null)
  const wtNewInputRef = useRef<HTMLInputElement>(null)
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set())
  const [currentTimeMillis, setCurrentTimeMillis] = useState(0)
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set())
  useEffect(
    () =>
      runBrowser(observeCurrentTime("1 minute", setCurrentTimeMillis), {
        onSuccess: () => undefined,
      }),
    [],
  )
  const loadSessions = useCallback(
    (showLoading = false) => {
      if (showLoading) setLoading(true)
      runApi(
        withApi((api) => api.sessions.list({})),
        {
          onSuccess: (data) => {
            const sessions = data.sessions.map((session) => ({
              ...session,
            }))
            setAllSessions(sessions)
            // Drop unread markers for sessions that no longer exist (e.g. deleted).
            const existingIds = new Set(sessions.map((s) => s.id))
            updateUnreadSessionIds((prev) => {
              if (prev.size === 0) return prev
              const next = new Set([...prev].filter((id) => existingIds.has(id)))
              return next.size === prev.size ? prev : next
            })
            setError(null)
            if (showLoading) setLoading(false)
          },
          onFailure: (error) => {
            setError(String(error))
            if (showLoading) setLoading(false)
          },
        },
      )
    },
    [updateUnreadSessionIds],
  )
  const initialLoadDone = useRef(false)
  useEffect(() => {
    const isFirst = !initialLoadDone.current
    initialLoadDone.current = true
    loadSessions(isFirst)
  }, [loadSessions, refreshKey])
  useEffect(() => {
    return runApi(
      observeRunningSessions({
        onSnapshot: (sessionIds) => {
          setRunningSessionIds((current) => {
            const next = new Set(sessionIds)
            return current.size === next.size && [...current].every((id) => next.has(id)) ? current : next
          })
        },
        onTransientError: () => undefined,
      }),
      {
        onSuccess: () => undefined,
      },
    )
  }, [])
  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId)
    const newlyRunning = [...runningSessionIds]
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      updateUnreadSessionIds((prev) => {
        const next = new Set(prev)
        newlyRunning.forEach((id) => next.delete(id))
        completedInBackground.forEach((id) => next.add(id))
        return next
      })
    }
    previousRunningSessionIdsRef.current = runningSessionIds
  }, [runningSessionIds, selectedSessionId, updateUnreadSessionIds])
  useEffect(() => {
    if (!selectedSessionId) return
    updateUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev
      const next = new Set(prev)
      next.delete(selectedSessionId)
      return next
    })
  }, [selectedSessionId, updateUnreadSessionIds])
  useEffect(() => {
    return runApi(
      withApi((api) => api.workspace.home({})),
      {
        onSuccess: ({ home }) => setHomeDir(home),
      },
    )
  }, [])
  const restoredRef = useRef(false)

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback(
    (cwd: string | null): string | null => {
      if (!cwd) return null
      if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot
      // Any path in the loaded worktree list belongs to that project — covers
      // worktrees without sessions, so switching to them keeps the row mounted.
      if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot
      const match = allSessions.find((s) => s.cwd === cwd)
      return match?.projectRoot ?? cwd
    },
    [worktreeState, allSessions],
  )

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return
    lastNotifiedCwdRef.current = selectedCwd
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd))
  }, [selectedCwd, onCwdChange, projectRootFor])

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp
      setSelectedCwd(selectedCwdProp)
    }
  }, [selectedCwdProp])

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0)
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null)
      setWorktreeLoadingCwd(null)
      return
    }
    setWorktreeLoadingCwd(selectedCwd)
    return runApi(
      withApi((api) =>
        api.workspace.worktrees({
          query: {
            cwd: selectedCwd,
          },
        }),
      ),
      {
        onSuccess: ({ project, worktrees }) => {
          setWorktreeLoadingCwd(null)
          setWorktreeState({
            forCwd: selectedCwd,
            projectRoot: project.projectRoot,
            isGit: worktrees.length > 0,
            isTopLevel: project.isTopLevel,
            worktrees: worktrees.map((worktree) => ({
              ...worktree,
            })),
          })
        },
        onFailure: () => {
          setWorktreeLoadingCwd(null)
          setWorktreeState(null)
        },
      },
    )
  }, [selectedCwd, wtRefreshKey, refreshKey])

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (loading) return
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true
      const target = allSessions.find((session) => session.id === initialSessionId)
      if (target) {
        setSelectedCwd(target.cwd)
        onSelectSession(target, true)
        return
      }
      onInitialRestoreDone?.()
    }
    if (allSessions.length === 0) return
    if (selectedCwd === null) {
      const projects = getRecentProjects(allSessions)
      if (projects.length > 0) setSelectedCwd(projects[0])
    }
  }, [allSessions, loading, selectedCwd, initialSessionId, onSelectSession, onInitialRestoreDone])
  const commitCustomPath = useCallback(() => {
    const path = customPathValue.trim()
    if (!path || customPathValidating) return
    setCustomPathValidating(true)
    setCustomPathError(null)
    runApi(
      withApi((api) =>
        api.workspace.validateCwd({
          payload: {
            cwd: path,
          },
        }),
      ),
      {
        onSuccess: ({ cwd }) => {
          setSelectedCwd(cwd)
          setCustomPathOpen(false)
          setCustomPathValue("")
          setDropdownOpen(false)
          setCustomPathValidating(false)
        },
        onFailure: (error) => {
          setCustomPathError(error instanceof Error ? error.message : String(error))
          setCustomPathValidating(false)
        },
      },
    )
  }, [customPathValue, customPathValidating])
  const pickCustomPath = useCallback(() => {
    if (customPathValidating) return
    setCustomPathValidating(true)
    setCustomPathError(null)
    runApi(
      withApi((api) =>
        api.workspace.pickCwd({
          payload: {},
        }),
      ),
      {
        onSuccess: ({ cwd }) => {
          if (cwd === null) {
            setCustomPathValidating(false)
            return
          }
          setSelectedCwd(cwd)
          setCustomPathOpen(false)
          setCustomPathValue("")
          setDropdownOpen(false)
          setCustomPathValidating(false)
        },
        onFailure: (error) => {
          setCustomPathError(error instanceof Error ? error.message : String(error))
          setCustomPathValidating(false)
        },
      },
    )
  }, [customPathValidating])
  const handleDefaultCwd = useCallback(() => {
    runApi(
      withApi((api) =>
        api.workspace.defaultCwd({
          payload: {},
        }),
      ),
      {
        onSuccess: ({ cwd }) => {
          setSelectedCwd(cwd)
          setCustomPathOpen(false)
          setCustomPathValue("")
          setCustomPathError(null)
          setDropdownOpen(false)
        },
      },
    )
  }, [])
  const handleCreateWorktree = useCallback(() => {
    const branch = wtNewBranch.trim()
    if (!branch || wtBusy || !worktreeState) return
    setWtBusy(true)
    setWtError(null)
    runApi(
      withApi((api) =>
        api.workspace.createWorktree({
          payload: {
            cwd: worktreeState.projectRoot,
            branch,
          },
        }),
      ),
      {
        onSuccess: (data) => {
          setWtNewOpen(false)
          setWtNewBranch("")
          setWtDropdownOpen(false)
          // Optimistically register the new worktree so projectRootFor() resolves
          // it to the main repo before the refetch lands (keeps AppShell from
          // treating the new cwd as a different project).
          setWorktreeState((prev) =>
            prev
              ? {
                  ...prev,
                  forCwd: data.path,
                  worktrees: [
                    ...prev.worktrees,
                    {
                      path: data.path,
                      branch,
                      isMain: false,
                    },
                  ],
                }
              : prev,
          )
          setSelectedCwd(data.path)
          setWtRefreshKey((k) => k + 1)
          setWtBusy(false)
        },
        onFailure: (error) => {
          setWtError(error instanceof Error ? error.message : String(error))
          setWtBusy(false)
        },
      },
    )
  }, [wtNewBranch, wtBusy, worktreeState])
  const handleRemoveWorktree = useCallback(
    (path: string, force: boolean) => {
      if (!worktreeState || wtBusy) return
      setWtBusy(true)
      setWtError(null)
      runApi(
        withApi((api) =>
          api.workspace.removeWorktree({
            payload: {
              cwd: worktreeState.projectRoot,
              path,
              force,
            },
          }),
        ),
        {
          onSuccess: () => {
            setWtConfirmRemove(null)
            if (selectedCwd === path) setSelectedCwd(worktreeState.projectRoot)
            setWtRefreshKey((k) => k + 1)
            setWtBusy(false)
          },
          onFailure: (error) => {
            if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Conflict" && !force) {
              // Dirty worktree — ask the user to confirm a force removal
              setWtConfirmRemove(path)
            } else {
              setWtError(error instanceof Error ? error.message : String(error))
            }
            setWtBusy(false)
          },
        },
      )
    },
    [worktreeState, wtBusy, selectedCwd],
  )

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setProjectFilter("")
        setCustomPathOpen(false)
        setCustomPathValue("")
        setCustomPathError(null)
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false)
        setWtNewOpen(false)
        setWtNewBranch("")
        setWtError(null)
        setWtConfirmRemove(null)
      }
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.onDocumentMouseDown(handler))), {
      onSuccess: () => undefined,
    })
  }, [])

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback(
    (s: SessionInfo) => {
      if (s.cwd) setSelectedCwd(s.cwd)
      onSelectSession(s)
    },
    [onSelectSession],
  )
  const handleNewSession = useCallback(() => {
    if (!selectedCwd || newSessionPending) return
    onNewSession?.(selectedCwd)
  }, [newSessionPending, selectedCwd, onNewSession])
  const recentProjects = getRecentProjects(allSessions)
  const showProjectFilter = recentProjects.length > 8
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectRootFor(selectedCwd)
  const filteredSessions = selectedProject
    ? allSessions.filter((s) => (s.projectRoot ?? s.cwd) === selectedProject)
    : allSessions
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit && worktreeState.isTopLevel && selectedCwd && selectedProject === worktreeState.projectRoot,
  )
  const worktreeGuide =
    selectedCwd && worktreeState && selectedProject === worktreeState.projectRoot && !showWorktreeSwitcher
      ? worktreeState.isGit
        ? {
            label: t("Open repo root"),
            title: t("Open the repository root to manage worktrees."),
          }
        : null
      : null
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd)
  const inactiveWorktreeSelector =
    worktreeGuide ??
    (worktreeLoading && !showWorktreeSwitcher
      ? {
          label: t("Worktrees..."),
          title: t("Checking worktrees for this directory."),
        }
      : null)

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions)
  return (
    <div {...stylex.props(inlineStyles.inline3)}>
      {/* Header */}
      <div {...stylex.props(inlineStyles.inline4)}>
        <div {...stylex.props(inlineStyles.inline5)}>
          <PiAgentTitle />
          <div {...stylex.props(inlineStyles.inline6)}>
            <button
              onClick={onOpenSettings}
              aria-expanded={settingsOpen}
              data-settings-trigger
              title={t("Settings")}
              aria-label={t("Settings")}
              {...stylex.props(inlineStyles.inline8)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.66.96.3.26.68.4 1.08.4H21v4h-.1A1.7 1.7 0 0 0 19.4 15Z" />
              </svg>
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} {...stylex.props(inlineStyles.inline9)}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject ?? selectedCwd ?? ""}
            {...stylex.props(inlineStyles.inline10)}
            style={{
              background: selectedCwd ? "var(--bg-raised)" : "var(--accent-soft)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid var(--accent)",
            }}
          >
            {selectedCwd ? (
              <>
                <span {...stylex.props(inlineStyles.projectMark)}>
                  {(selectedProject ?? selectedCwd).split("/").filter(Boolean).at(-1)?.slice(0, 2).toUpperCase() ??
                    "PI"}
                </span>
                <span {...stylex.props(inlineStyles.projectIdentity)}>
                  <strong>{(selectedProject ?? selectedCwd).split("/").filter(Boolean).at(-1)}</strong>
                  <PathLabel text={displayCwd(selectedProject ?? selectedCwd, homeDir)} />
                </span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </>
            ) : (
              <span {...stylex.props(inlineStyles.inline11)}>
                {initialSessionId && !restoredRef.current ? "" : t("Select project…")}
              </span>
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
            {showProjectFilter && (
              <div {...stylex.props(inlineStyles.inline12)}>
                <input
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setProjectFilter("")
                      setDropdownOpen(false)
                    }
                  }}
                  placeholder={t("Filter projects…")}
                  autoFocus
                  {...stylex.props(inlineStyles.inline13)}
                />
              </div>
            )}
            <div {...stylex.props(inlineStyles.inline14)}>
              {visibleProjects.map((project) => (
                <button
                  key={project}
                  onClick={() => {
                    setSelectedCwd(project)
                    setProjectFilter("")
                    setCustomPathOpen(false)
                    setCustomPathValue("")
                    setCustomPathError(null)
                    setDropdownOpen(false)
                  }}
                  {...stylex.props(inlineStyles.inline15)}
                  style={{
                    color: project === selectedProject ? "var(--text)" : "var(--text-muted)",
                  }}
                  title={project}
                >
                  {project === selectedProject && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      {...stylex.props(inlineStyles.inline16)}
                    >
                      <polyline points="1.5 5 4 7.5 8.5 2.5" />
                    </svg>
                  )}
                  {project !== selectedProject && <span {...stylex.props(inlineStyles.inline17)} />}
                  <PathLabel
                    text={displayCwd(project, homeDir)}
                    style={{
                      flex: 1,
                    }}
                  />
                </button>
              ))}
              {visibleProjects.length === 0 && projectFilter.trim() && (
                <div {...stylex.props(inlineStyles.inline18)}>{t("No matching projects")}</div>
              )}
            </div>

            {/* Default cwd shortcut */}
            {!customPathOpen && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDefaultCwd()
                }}
                {...stylex.props(inlineStyles.inline19)}
                style={{
                  borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  {...stylex.props(inlineStyles.inline20)}
                >
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>{t("Use default directory")}</span>
              </button>
            )}

            {/* Native macOS folder picker */}
            {!customPathOpen && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  pickCustomPath()
                }}
                disabled={customPathValidating}
                {...stylex.props(inlineStyles.inline21)}
                style={{
                  cursor: customPathValidating ? "wait" : "pointer",
                  opacity: customPathValidating ? 0.65 : 1,
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  {...stylex.props(inlineStyles.inline22)}
                >
                  <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                </svg>
                <span>{customPathValidating ? t("Choosing…") : t("Choose folder…")}</span>
              </button>
            )}

            {/* Custom path entry */}
            {!customPathOpen ? (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setCustomPathOpen(true)
                  setCustomPathError(null)
                  runBrowser(
                    after("0 millis", () => customPathInputRef.current?.focus()),
                    {
                      onSuccess: () => undefined,
                    },
                  )
                }}
                {...stylex.props(inlineStyles.inline23)}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  {...stylex.props(inlineStyles.inline24)}
                >
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("Enter path manually…")}</span>
              </button>
            ) : (
              <div
                {...stylex.props(inlineStyles.inline25)}
                style={{
                  borderTop: visibleProjects.length > 0 ? "none" : undefined,
                }}
              >
                <input
                  ref={customPathInputRef}
                  value={customPathValue}
                  onChange={(e) => {
                    setCustomPathValue(e.target.value)
                    setCustomPathError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitCustomPath()
                    }
                    if (e.key === "Escape") {
                      setCustomPathOpen(false)
                      setCustomPathValue("")
                      setCustomPathError(null)
                    }
                  }}
                  placeholder="/path/to/project"
                  {...stylex.props(inlineStyles.inline26)}
                />
                <div {...stylex.props(inlineStyles.inline27)}>
                  <button
                    onClick={() => commitCustomPath()}
                    disabled={customPathValidating || !customPathValue.trim()}
                    {...stylex.props(inlineStyles.inline28)}
                    style={{
                      cursor: customPathValidating || !customPathValue.trim() ? "not-allowed" : "pointer",
                      opacity: customPathValidating || !customPathValue.trim() ? 0.65 : 1,
                    }}
                  >
                    {customPathValidating ? t("Checking…") : t("Open")}
                  </button>
                  <button
                    onClick={() => {
                      setCustomPathOpen(false)
                      setCustomPathValue("")
                      setCustomPathError(null)
                    }}
                    {...stylex.props(inlineStyles.inline29)}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </div>
            )}
            {customPathError && <div {...stylex.props(inlineStyles.inline30)}>{customPathError}</div>}
          </AnimatedDropdown>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher &&
          (() => {
            if (!worktreeState) return null
            const currentWt =
              worktreeState.worktrees.find((w) => w.path === selectedCwd) ??
              worktreeState.worktrees.find((w) => w.isMain)
            return (
              <div ref={wtDropdownRef} {...stylex.props(inlineStyles.inline31)}>
                <button
                  onClick={() => setWtDropdownOpen((v) => !v)}
                  title={currentWt ? `${t("Switch worktree")}: ${currentWt.path}` : t("Switch worktree")}
                  {...stylex.props(inlineStyles.inline32)}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    {...stylex.props(inlineStyles.inline33)}
                    style={{
                      color: currentWt && !currentWt.isMain ? "var(--accent)" : "var(--text-dim)",
                    }}
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <PathLabel
                    text={currentWt ? (currentWt.branch ?? displayCwd(currentWt.path, homeDir)) : "…"}
                    style={{
                      flex: 1,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text)",
                    }}
                  />
                  {currentWt?.isMain && <span {...stylex.props(inlineStyles.inline34)}>main</span>}
                  {worktreeState.worktrees.length > 1 && (
                    <span {...stylex.props(inlineStyles.inline35)}>{worktreeState.worktrees.length}</span>
                  )}
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    {...stylex.props(inlineStyles.inline36)}
                  >
                    <polyline points="2 3.5 5 6.5 8 3.5" />
                  </svg>
                </button>

                <AnimatedDropdown
                  open={wtDropdownOpen}
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: 0,
                    zIndex: 100,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                    overflow: "hidden",
                  }}
                >
                  <div {...stylex.props(inlineStyles.inline37)}>
                    {worktreeState.worktrees.map((wt) => {
                      const isCurrent =
                        wt.path === selectedCwd ||
                        (wt.isMain && !worktreeState.worktrees.some((w) => w.path === selectedCwd))
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} {...stylex.props(inlineStyles.inline38)}>
                            <span {...stylex.props(inlineStyles.inline39)}>
                              {t("Uncommitted changes. Force remove checkout?")}
                            </span>
                            <button
                              onClick={() => handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              {...stylex.props(inlineStyles.inline40)}
                            >
                              {t("Force")}
                            </button>
                            <button onClick={() => setWtConfirmRemove(null)} {...stylex.props(inlineStyles.inline41)}>
                              {t("Cancel")}
                            </button>
                          </div>
                        )
                      }
                      return (
                        <div key={wt.path} className={`${stylex.props(inlineStyles.inline42).className} wt-row`}>
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path)
                              setWtDropdownOpen(false)
                              setWtError(null)
                            }}
                            title={wt.path}
                            {...stylex.props(inlineStyles.inline43)}
                            style={{
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                            }}
                          >
                            {isCurrent ? (
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                {...stylex.props(inlineStyles.inline44)}
                              >
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span {...stylex.props(inlineStyles.inline45)} />
                            )}
                            <PathLabel
                              text={wt.branch ?? displayCwd(wt.path, homeDir)}
                              style={{
                                flex: 1,
                              }}
                            />
                            {wt.isMain && <span {...stylex.props(inlineStyles.inline46)}>main</span>}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                              title={`Remove worktree checkout ${wt.path}; the branch is kept`}
                              {...stylex.props(inlineStyles.inline47)}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = "#ef4444"
                                e.currentTarget.style.background = "rgba(239,68,68,0.08)"
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = "var(--text-dim)"
                                e.currentTarget.style.background = "none"
                              }}
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setWtNewOpen(true)
                        setWtError(null)
                        runBrowser(
                          after("0 millis", () => wtNewInputRef.current?.focus()),
                          {
                            onSuccess: () => undefined,
                          },
                        )
                      }}
                      title={t("Create a worktree checkout for a branch")}
                      {...stylex.props(inlineStyles.inline48)}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                        {...stylex.props(inlineStyles.inline49)}
                      >
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                      <span>{t("New worktree…")}</span>
                    </button>
                  ) : (
                    <div {...stylex.props(inlineStyles.inline50)}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value)
                          setWtError(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            handleCreateWorktree()
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false)
                            setWtNewBranch("")
                            setWtError(null)
                          }
                        }}
                        placeholder={t("branch name")}
                        {...stylex.props(inlineStyles.inline51)}
                      />
                      <div {...stylex.props(inlineStyles.inline52)}>
                        <button
                          onClick={() => handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          {...stylex.props(inlineStyles.inline53)}
                          style={{
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                          {t(wtBusy ? "Creating…" : "Create")}
                        </button>
                        <button
                          onClick={() => {
                            setWtNewOpen(false)
                            setWtNewBranch("")
                            setWtError(null)
                          }}
                          {...stylex.props(inlineStyles.inline54)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && <div {...stylex.props(inlineStyles.inline55)}>{wtError}</div>}
                </AnimatedDropdown>
              </div>
            )
          })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            {...stylex.props(inlineStyles.inline56)}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(inlineStyles.inline57)}
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span {...stylex.props(inlineStyles.inline58)}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>

      <div {...stylex.props(inlineStyles.sessionActions)}>
        <button
          type="button"
          onClick={handleNewSession}
          disabled={!selectedCwd || newSessionPending}
          title={t("New session")}
          {...stylex.props(inlineStyles.sessionAction)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>{t(newSessionPending ? "Creating…" : "New session")}</span>
        </button>
        <button
          type="button"
          onClick={() => loadSessions()}
          title={t("Refresh sessions")}
          aria-label={t("Refresh sessions")}
          {...stylex.props(inlineStyles.sessionActionIcon)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 11a8.1 8.1 0 1 0 .2 4M20 4v7h-7" />
          </svg>
        </button>
      </div>

      {/* Session list */}
      <div {...stylex.props(inlineStyles.sessionLabel)}>
        <span>{locale === "zh-CN" ? "会话" : "Sessions"}</span>
      </div>
      <div {...stylex.props(inlineStyles.inline59)}>
        {loading && <div {...stylex.props(inlineStyles.inline60)}>{t("Loading...")}</div>}
        {error && <div {...stylex.props(inlineStyles.inline61)}>{error}</div>}
        {!loading && !error && filteredSessions.length === 0 && (
          <div {...stylex.props(inlineStyles.inline62)}>{t("No sessions found")}</div>
        )}
        {sessionTree.map((node) => (
          <SessionTreeItem
            key={node.session.id}
            node={node}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            currentTimeMillis={currentTimeMillis}
            onSelectSession={handleSelectSessionFromList}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id)
              loadSessions()
            }}
            depth={0}
          />
        ))}
      </div>

      {(selectedCwdProp || selectedCwd) && (
        <button type="button" onClick={onOpenExplorer} {...stylex.props(inlineStyles.explorerButton)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13Z" />
          </svg>
          <span>{t("Resource manager")}</span>
          <kbd {...stylex.props(inlineStyles.shortcutHint)}>⌘⇧E</kbd>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="m3 2 3 3-3 3" />
          </svg>
        </button>
      )}
    </div>
  )
}
function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  currentTimeMillis,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode
  selectedSessionId: string | null
  runningSessionIds: Set<string>
  unreadSessionIds: Set<string>
  currentTimeMillis: number
  onSelectSession: (s: SessionInfo) => void
  onRenamed?: () => void
  onSessionDeleted?: (id: string) => void
  depth: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const hasChildren = node.children.length > 0
  return (
    <div>
      <div {...stylex.props(inlineStyles.inline69)}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div
            {...stylex.props(inlineStyles.inline70)}
            style={{
              left: depth * 12 + 6,
            }}
          />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          currentTimeMillis={currentTimeMillis}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              currentTimeMillis={currentTimeMillis}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}
function RunningSessionIndicator() {
  const { t } = useI18n()
  return (
    <span title={t("Agent running…")} aria-label={t("Agent running")} {...stylex.props(inlineStyles.inline71)}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        {...stylex.props(inlineStyles.inline72)}
      >
        <g>
          <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  )
}
function UnreadSessionIndicator() {
  const { t } = useI18n()
  return (
    <span title={t("New activity")} aria-label={t("New session activity")} {...stylex.props(inlineStyles.inline73)}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        {...stylex.props(inlineStyles.inline74)}
      >
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  )
}
function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  currentTimeMillis,
}: {
  session: SessionInfo
  isSelected: boolean
  isRunning?: boolean
  isUnread?: boolean
  onClick: () => void
  onRenamed?: () => void
  onDeleted?: (id: string) => void
  depth?: number
  hasChildren?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
  currentTimeMillis: number
}) {
  const { t, locale } = useI18n()
  const [hovered, setHovered] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12)
  const startRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setRenameValue(session.name ?? "")
      setRenaming(true)
      runBrowser(
        after("0 millis", () => inputRef.current?.select()),
        {
          onSuccess: () => undefined,
        },
      )
    },
    [session.name],
  )
  const commitRename = useCallback(() => {
    const name = renameValue.trim()
    setRenaming(false)
    if (name === (session.name ?? "")) return
    runApi(
      withApi((api) =>
        api.sessions.rename({
          params: {
            id: session.id,
          },
          payload: {
            name,
          },
        }),
      ),
      {
        onSuccess: () => onRenamed?.(),
      },
    )
  }, [renameValue, session.id, session.name, onRenamed])
  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDelete(true)
  }, [])
  const handleDeleteConfirm = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setConfirmDelete(false)
      setDeleting(true)
      runApi(
        withApi((api) =>
          api.sessions.remove({
            params: {
              id: session.id,
            },
          }),
        ),
        {
          onSuccess: () => onDeleted?.(session.id),
          onFailure: () => setDeleting(false),
        },
      )
    },
    [session.id, onDeleted],
  )
  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDelete(false)
  }, [])

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54
  return (
    <div
      data-session-id={session.id}
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false)
      }}
      {...stylex.props(inlineStyles.inline75)}
      style={{
        height: ITEM_HEIGHT,
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected
            ? "var(--bg-selected)"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
        borderLeft: "2px solid transparent",
        opacity: deleting ? 0.5 : 1,
      }}
    >
      {confirmDelete /* ── Delete confirmation: same height, two flat buttons ── */ ? (
        <>
          <div {...stylex.props(inlineStyles.inline76)}>
            {t("Delete")}{" "}
            <span {...stylex.props(inlineStyles.inline77)}>
              &ldquo;{title.slice(0, 22)}
              {title.length > 22 ? "…" : ""}&rdquo;
            </span>
            ?
          </div>
          <div {...stylex.props(inlineStyles.inline78)}>
            <button onClick={handleDeleteConfirm} {...stylex.props(inlineStyles.inline79)}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("Delete")}
            </button>
            <button onClick={handleDeleteCancel} {...stylex.props(inlineStyles.inline80)}>
              {t("Cancel")}
            </button>
          </div>
        </>
      ) : renaming /* ── Rename: input fills the same row ── */ ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename()
            if (e.key === "Escape") setRenaming(false)
          }}
          autoFocus
          {...stylex.props(inlineStyles.inline81)}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-dim)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(inlineStyles.inline82)}
            >
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div {...stylex.props(inlineStyles.inline83)}>
            <div
              {...stylex.props(inlineStyles.inline84)}
              style={{
                fontWeight: isSelected ? 500 : 400,
              }}
              title={
                isRunning ? `${title} · ${t("Agent running…")}` : isUnread ? `${title} · ${t("New activity")}` : title
              }
            >
              {isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : null}
              <span {...stylex.props(inlineStyles.inline85)}>{title}</span>
            </div>
            <div {...stylex.props(inlineStyles.inline86)}>
              <span title={session.modified}>{formatRelativeTime(session.modified, locale, currentTimeMillis)}</span>
              <span>{locale === "zh-CN" ? `${session.messageCount} 条消息` : `${session.messageCount} msgs`}</span>
              {session.worktreeBranch && (
                <span title={`Worktree: ${session.cwd}`} {...stylex.props(inlineStyles.inline87)}>
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    {...stylex.props(inlineStyles.inline88)}
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span {...stylex.props(inlineStyles.inline89)}>{session.worktreeBranch}</span>
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapse?.()
              }}
              title={t(collapsed ? "Expand forks" : "Collapse forks")}
              {...stylex.props(inlineStyles.inline90)}
              style={{
                transform: collapsed ? "rotate(-90deg)" : "none",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hovered && (
            <div {...stylex.props(inlineStyles.inline91)}>
              <button
                onClick={startRename}
                title={t("Rename")}
                {...stylex.props(inlineStyles.inline92)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)"
                  e.currentTarget.style.color = "var(--accent)"
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)"
                  e.currentTarget.style.color = "var(--text-muted)"
                  e.currentTarget.style.borderColor = "var(--border)"
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("Delete")}
                {...stylex.props(inlineStyles.inline93)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)"
                  e.currentTarget.style.color = "#ef4444"
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)"
                  e.currentTarget.style.color = "var(--text-muted)"
                  e.currentTarget.style.borderColor = "var(--border)"
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    unicodeBidi: "plaintext",
  },
  inline2: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "default",
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: "-0.01em",
    fontFamily: "inherit",
    minWidth: "6ch",
  },
  inline3: {
    background: "var(--bg-panel)",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  inline4: {
    padding: "0 10px 10px",
    flexShrink: 0,
  },
  inline5: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 58,
  },
  brand: {
    alignItems: "center",
    display: "flex",
    gap: 10,
  },
  brandMark: {
    alignItems: "center",
    background: "var(--text)",
    borderRadius: 9,
    color: "var(--bg-panel)",
    display: "flex",
    fontFamily: "Georgia, serif",
    fontSize: 20,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  inline6: {
    display: "flex",
    gap: 6,
  },
  inline7: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    height: 32,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "-0.01em",
    flexShrink: 0,
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  },
  inline8: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    width: 32,
    height: 32,
    borderRadius: 7,
    padding: 0,
    flexShrink: 0,
    transition: "background 0.3s, color 0.3s, border-color 0.3s",
  },
  inline9: {
    position: "relative",
  },
  inline10: {
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    gap: 9,
    height: 48,
    width: "100%",
    display: "flex",
    alignItems: "center",
    padding: "0 10px",
    borderRadius: 10,
    cursor: "pointer",
    fontSize: 12,
    color: "var(--text)",
    textAlign: "left",
    transition: "border-color 0.15s, background 0.15s",
  },
  projectMark: {
    alignItems: "center",
    background: "var(--success)",
    borderRadius: 7,
    color: "white",
    display: "flex",
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 800,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  projectIdentity: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    minWidth: 0,
  },
  inline11: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline12: {
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
  },
  inline13: {
    width: "100%",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    padding: "5px 8px",
    border: "1px solid var(--border)",
    borderRadius: 5,
    outline: "none",
    background: "var(--bg)",
    color: "var(--text)",
    boxSizing: "border-box",
  },
  inline14: {
    maxHeight: "min(50vh, 380px)",
    overflowY: "auto",
  },
  inline15: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "8px 10px",
    background: "var(--bg)",
    border: "none",
    borderBottom: "1px solid var(--border)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline16: {
    flexShrink: 0,
  },
  inline17: {
    width: 10,
    flexShrink: 0,
  },
  inline18: {
    padding: "8px 10px",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline19: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "8px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
  },
  inline20: {
    flexShrink: 0,
  },
  inline21: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "8px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    textAlign: "left",
    fontSize: 11,
  },
  inline22: {
    flexShrink: 0,
  },
  inline23: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "8px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
  },
  inline24: {
    flexShrink: 0,
  },
  inline25: {
    padding: "6px 8px",
  },
  inline26: {
    width: "100%",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    padding: "5px 8px",
    border: "1px solid var(--accent)",
    borderRadius: 5,
    outline: "none",
    background: "var(--bg)",
    color: "var(--text)",
    boxSizing: "border-box",
  },
  inline27: {
    display: "flex",
    gap: 5,
    marginTop: 5,
  },
  inline28: {
    flex: 1,
    padding: "4px 0",
    background: "var(--accent)",
    border: "none",
    borderRadius: 5,
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
  },
  inline29: {
    flex: 1,
    padding: "4px 0",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    color: "var(--text-muted)",
    fontSize: 11,
    cursor: "pointer",
  },
  inline30: {
    padding: "0 8px 7px",
    color: "#dc2626",
    fontSize: 11,
    lineHeight: 1.35,
    overflowWrap: "anywhere",
  },
  inline31: {
    position: "relative",
    marginTop: 6,
  },
  inline32: {
    width: "100%",
    height: 29,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 10px",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1.35,
    color: "var(--text-muted)",
    textAlign: "left",
  },
  inline33: {
    flexShrink: 0,
  },
  inline34: {
    flexShrink: 0,
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline35: {
    flexShrink: 0,
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline36: {
    flexShrink: 0,
  },
  inline37: {
    maxHeight: "min(40vh, 300px)",
    overflowY: "auto",
  },
  inline38: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
    background: "rgba(239,68,68,0.06)",
  },
  inline39: {
    flex: 1,
    fontSize: 11,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline40: {
    padding: "3px 9px",
    background: "#ef4444",
    border: "none",
    borderRadius: 5,
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
  },
  inline41: {
    padding: "3px 9px",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    color: "var(--text-muted)",
    fontSize: 11,
    cursor: "pointer",
    flexShrink: 0,
  },
  inline42: {
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
  },
  inline43: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 10px",
    background: "var(--bg)",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  },
  inline44: {
    flexShrink: 0,
  },
  inline45: {
    width: 10,
    flexShrink: 0,
  },
  inline46: {
    flexShrink: 0,
    color: "var(--text-dim)",
    fontSize: 10,
  },
  inline47: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 28,
    padding: 0,
    marginRight: 4,
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    borderRadius: 5,
    flexShrink: 0,
    transition: "color 0.12s, background 0.12s",
  },
  inline48: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "8px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
  },
  inline49: {
    flexShrink: 0,
  },
  inline50: {
    padding: "6px 8px",
  },
  inline51: {
    width: "100%",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    padding: "5px 8px",
    border: "1px solid var(--accent)",
    borderRadius: 5,
    outline: "none",
    background: "var(--bg)",
    color: "var(--text)",
    boxSizing: "border-box",
  },
  inline52: {
    display: "flex",
    gap: 5,
    marginTop: 5,
  },
  inline53: {
    flex: 1,
    padding: "4px 0",
    background: "var(--accent)",
    border: "none",
    borderRadius: 5,
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
  },
  inline54: {
    flex: 1,
    padding: "4px 0",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    color: "var(--text-muted)",
    fontSize: 11,
    cursor: "pointer",
  },
  inline55: {
    padding: "5px 10px 8px",
    color: "#dc2626",
    fontSize: 11,
    lineHeight: 1.35,
    overflowWrap: "anywhere",
  },
  inline56: {
    width: "100%",
    height: 29,
    boxSizing: "border-box",
    marginTop: 6,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 10px",
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--bg-hover)",
    color: "var(--text-dim)",
    fontSize: 11,
    lineHeight: 1.35,
    whiteSpace: "nowrap",
    textAlign: "left",
    cursor: "default",
    opacity: 0.82,
  },
  inline57: {
    flexShrink: 0,
  },
  inline58: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  inline59: {
    flex: 1,
    overflowY: "auto",
    padding: "0 7px",
    minHeight: 80,
  },
  sessionLabel: {
    color: "var(--text-dim)",
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: ".06em",
    padding: "18px 16px 6px",
    textTransform: "uppercase",
  },
  sessionActions: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 10px",
    flexShrink: 0,
  },
  sessionAction: {
    flex: 1,
    height: 35,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--text)",
    color: "var(--bg-panel)",
    fontSize: 12,
    fontWeight: 650,
    cursor: "pointer",
  },
  sessionActionIcon: {
    width: 30,
    height: 35,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--bg-raised)",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  explorerButton: {
    width: "100%",
    height: 44,
    padding: "0 14px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    border: "none",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
  },
  inline60: {
    padding: "16px 14px",
    color: "var(--text-muted)",
    fontSize: 12,
  },
  inline61: {
    padding: "12px 14px",
    color: "#f87171",
    fontSize: 12,
  },
  inline62: {
    padding: "16px 14px",
    color: "var(--text-muted)",
    fontSize: 12,
  },
  inline63: {
    borderTop: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  inline64: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  inline65: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    padding: "6px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    textAlign: "left",
  },
  inline66: {
    transition: "transform 0.15s",
    flexShrink: 0,
  },
  inline67: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    padding: 0,
    marginRight: 6,
    border: "none",
    cursor: "pointer",
    borderRadius: 5,
    flexShrink: 0,
    transition: "color 0.3s, background 0.3s",
  },
  inline68: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
  },
  inline69: {
    position: "relative",
  },
  inline70: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    background: "var(--border)",
    pointerEvents: "none",
  },
  inline71: {
    width: 14,
    height: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "var(--accent)",
  },
  inline72: {
    display: "block",
  },
  inline73: {
    width: 14,
    height: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "#0891b2",
  },
  inline74: {
    display: "block",
  },
  inline75: {
    display: "flex",
    alignItems: "center",
    paddingRight: 8,
    transition: "background 0.1s",
    gap: 6,
    overflow: "hidden",
    borderRadius: 8,
    marginBottom: 2,
  },
  inline76: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline77: {
    fontWeight: 600,
  },
  inline78: {
    display: "flex",
    gap: 5,
    flexShrink: 0,
  },
  inline79: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 30,
    padding: "0 11px",
    background: "#ef4444",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  inline80: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 30,
    padding: "0 11px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  inline81: {
    flex: 1,
    fontSize: 12,
    padding: "5px 8px",
    border: "1px solid var(--accent)",
    borderRadius: 5,
    outline: "none",
    background: "var(--bg)",
    color: "var(--text)",
    height: 30,
  },
  inline82: {
    flexShrink: 0,
  },
  inline83: {
    flex: 1,
    minWidth: 0,
  },
  inline84: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 1.4,
    color: "var(--text)",
  },
  inline85: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  inline86: {
    marginTop: 2,
    display: "flex",
    gap: 8,
    color: "var(--text-dim)",
    fontSize: 10,
    minWidth: 0,
  },
  inline87: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    color: "var(--accent)",
    minWidth: 0,
    overflow: "hidden",
  },
  inline88: {
    flexShrink: 0,
  },
  inline89: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline90: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    flexShrink: 0,
    background: "none",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    transition: "transform 0.15s",
  },
  inline91: {
    display: "flex",
    gap: 4,
    flexShrink: 0,
  },
  inline92: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    padding: 0,
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  },
  inline93: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    padding: 0,
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  },
  shortcutHint: {
    color: "var(--text-dim)",
    fontFamily: "inherit",
    fontSize: 10,
    marginLeft: "auto",
  },
})
