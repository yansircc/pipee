import * as stylex from "@stylexjs/stylex"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useIsMobile } from "@/hooks/useIsMobile"
import type { PluginPackageInfo, PluginsResponse, WeixinStatusProjection } from "@/api/contract"
import { useI18n } from "@/lib/i18n"
import { withApi, runApi } from "@/browser/api-client"
import { apiUrls, runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { Effect } from "effect"
import type { ChromeExtensionHealth } from "@/lib/chrome-extension-installation"
import { PI_COMPANION_PACKAGE_NAMES } from "@/lib/plugin-package-settings"
import { SettingsToggle as Toggle } from "@/ui/interaction/SettingsToggle"
import { SettingsWorkspace } from "@/ui/interaction/SettingsWorkspace"
type PluginScope = PluginPackageInfo["scope"]
type PluginAction = "install" | "remove" | "update" | "disable" | "enable"
const clonePlugins = (value: PluginsResponse): PluginsResponse => {
  const response = value as {
    readonly packages: ReadonlyArray<
      PluginPackageInfo & {
        readonly resources: ReadonlyArray<PluginPackageInfo["resources"][number]>
      }
    >
    readonly totals: PluginsResponse["totals"]
    readonly diagnostics: ReadonlyArray<PluginsResponse["diagnostics"][number]>
  }
  return {
    packages: response.packages.map((pkg) => ({
      ...pkg,
      counts: {
        ...pkg.counts,
      },
      resources: pkg.resources.map((resource) => ({
        ...resource,
      })),
    })),
    totals: {
      ...response.totals,
    },
    diagnostics: response.diagnostics.map((diagnostic) => ({
      ...diagnostic,
    })),
  }
}
function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~")
}
function packageDisplayName(pkg: Pick<PluginPackageInfo, "packageName" | "source">): string {
  const value = pkg.packageName ?? pkg.source
  if (!value.startsWith(".") && !value.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(value)) return value
  const normalized = value.replace(/[\\/]+$/, "").replace(/\\/g, "/")
  return normalized.split("/").pop() ?? value
}
function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope" | "ownerCwd">): string {
  return `${pkg.ownerCwd ?? ""}\0${pkg.scope}\0${pkg.source}`
}
function resourceSummary(pkg: PluginPackageInfo): string {
  if (pkg.disabled) return "Disabled"
  const parts = [
    pkg.counts.extensions ? `${pkg.counts.extensions} ext` : "",
    pkg.counts.skills ? `${pkg.counts.skills} skills` : "",
    pkg.counts.prompts ? `${pkg.counts.prompts} prompts` : "",
    pkg.counts.themes ? `${pkg.counts.themes} themes` : "",
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "No resources"
}
function packageSubtitle(pkg: PluginPackageInfo): string {
  const version = pkg.version ?? pkg.configuredVersion
  return [pkg.source, version ? `v${version}` : null, pkg.scope, resourceSummary(pkg)].filter(Boolean).join(" · ")
}
function versionSummary(pkg: PluginPackageInfo): string {
  const parts = []
  if (pkg.version) parts.push(`installed ${pkg.version}`)
  if (pkg.configuredVersion) parts.push(`configured ${pkg.configuredVersion}`)
  return parts.length ? parts.join(" · ") : "Unknown"
}
function installLocation(scope: PluginScope, cwd: string | null): string {
  return scope === "project" && cwd !== null ? `${shortenPath(cwd)}/.pi/agent/{npm,git}` : "~/.pi/agent/{npm,git}"
}
function findInstalledPackage(
  packages: ReadonlyArray<PluginPackageInfo>,
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim()
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed
  return (
    packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed) ??
    packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`) ??
    packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed))
  )
}
function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)"
  if (status === "installed") return "#f59e0b"
  if (status === "disabled") return "var(--text-dim)"
  return "#ef4444"
}
function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const groups = (
    [
      ["extension", "Extensions"],
      ["skill", "Skills"],
      ["prompt", "Prompts"],
      ["theme", "Themes"],
    ] as const
  )
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0)
  if (groups.length === 0) {
    return (
      <div {...stylex.props(inlineStyles.inline1)}>{pkg.disabled ? "Package disabled" : "No resolved resources"}</div>
    )
  }
  return (
    <div {...stylex.props(inlineStyles.inline2)}>
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div {...stylex.props(inlineStyles.inline3)}>{group.label}</div>
          <div {...stylex.props(inlineStyles.inline4)}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} {...stylex.props(inlineStyles.inline5)}>
                <div {...stylex.props(inlineStyles.inline6)} title={resource.path}>
                  {resource.name}
                </div>
                <div {...stylex.props(inlineStyles.inline7)} title={resource.path}>
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
function ScopeTag({ scope }: { scope: PluginScope }) {
  return (
    <span
      {...stylex.props(inlineStyles.inline8)}
      style={{
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope}
    </span>
  )
}
function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  }
}
function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none">
      <path
        d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none">
      <path
        d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function SegmentedScope({
  value,
  onChange,
  allowProject = true,
}: {
  value: PluginScope
  onChange: (scope: PluginScope) => void
  allowProject?: boolean
}) {
  return (
    <div {...stylex.props(inlineStyles.inline11)}>
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope
        const disabled = scope === "project" && !allowProject
        return (
          <button
            key={scope}
            disabled={disabled}
            onClick={() => onChange(scope)}
            {...stylex.props(inlineStyles.inline12)}
            style={{
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
            }}
          >
            {scope}
          </button>
        )
      })}
    </div>
  )
}
function AddPluginPanel({
  cwd,
  projectCwds = [],
  projectCwd,
  source,
  scope,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onProjectCwdChange,
  onInstall,
  onClose,
}: {
  cwd: string | null
  projectCwds?: ReadonlyArray<string>
  projectCwd?: string | null
  source: string
  scope: PluginScope
  busy: boolean
  actionError: string | null
  onSourceChange: (value: string) => void
  onScopeChange: (scope: PluginScope) => void
  onProjectCwdChange?: (cwd: string) => void
  onInstall: () => void
  onClose?: () => void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"]
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <div {...stylex.props(inlineStyles.inline13)}>
      <div {...stylex.props(inlineStyles.inline14)}>
        <div {...stylex.props(inlineStyles.addHeaderCopy)}>
          <div {...stylex.props(inlineStyles.inline15)}>{t("Add Plugin")}</div>
          <div {...stylex.props(inlineStyles.inline16)}>{installLocation(scope, cwd)}</div>
        </div>
        {onClose && (
          <button {...stylex.props(inlineStyles.pageCloseButton)} onClick={onClose}>
            ×
          </button>
        )}
      </div>

      <div {...stylex.props(inlineStyles.inline17)}>
        <label htmlFor="plugin-source" {...stylex.props(inlineStyles.inline18)}>
          {t("Source")}
        </label>
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder="npm:@scope/package"
          {...stylex.props(inlineStyles.inline19)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall()
          }}
        />
      </div>

      <div {...stylex.props(inlineStyles.inline20)}>
        <SegmentedScope value={scope} onChange={onScopeChange} allowProject={cwd !== null} />
        {scope === "project" && projectCwds.length > 0 && onProjectCwdChange && (
          <select
            aria-label="Project plugin owner"
            value={projectCwd ?? projectCwds[0]}
            onChange={(event) => onProjectCwdChange(event.target.value)}
            {...stylex.props(inlineStyles.pageProjectSelect)}
          >
            {projectCwds.map((project) => (
              <option key={project} value={project}>
                {shortenPath(project)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onInstall}
          disabled={busy || !source.trim()}
          style={{
            ...buttonStyle(busy || !source.trim()),
            background: "var(--accent)",
            color: "white",
            borderColor: "var(--accent)",
          }}
        >
          {t(busy ? "Installing..." : "Install")}
        </button>
      </div>

      <div {...stylex.props(inlineStyles.inline21)}>
        <div {...stylex.props(inlineStyles.inline22)}>{t("Examples")}</div>
        <div {...stylex.props(inlineStyles.inline23)}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              {...stylex.props(inlineStyles.inline24)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)"
                e.currentTarget.style.color = "var(--text-muted)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)"
                e.currentTarget.style.color = "var(--text-dim)"
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && <div {...stylex.props(inlineStyles.inline25)}>{actionError}</div>}
    </div>
  )
}
function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  onAction,
  onReloadSession,
  chromeHealth,
  weixinStatus,
}: {
  pkg: PluginPackageInfo
  cwd: string | null
  busyKey: string | null
  actionError: string | null
  actionMessage: string | null
  sessionId: string | null
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void
  onReloadSession: () => void
  chromeHealth: ChromeExtensionHealth | null
  weixinStatus: WeixinStatusProjection | undefined
}) {
  const { t } = useI18n()
  const key = packageKey(pkg)
  const busy = busyKey?.endsWith(key) ?? false
  const reloadBusy = busyKey === "reload"
  const enabled = !pkg.disabled
  const isChrome = pkg.scope === "global" && pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome
  const isWeixin = pkg.scope === "global" && pkg.packageName === PI_COMPANION_PACKAGE_NAMES.weixin
  const openChromeInstallationGuide = () => {
    runBrowser(
      BrowserPlatform.pipe(
        Effect.flatMap((browser) =>
          browser.openExternal(
            "https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked",
          ),
        ),
      ),
      {
        onSuccess: () => undefined,
      },
    )
  }
  return (
    <div {...stylex.props(inlineStyles.inline26)}>
      {isChrome && chromeHealth !== null && chromeHealth._tag !== "Ready" && chromeHealth._tag !== "NotInstalled" && (
        <div {...stylex.props(inlineStyles.inline27)}>
          <div>
            <div {...stylex.props(inlineStyles.inline28)}>
              {t(
                chromeHealth._tag === "Missing"
                  ? "Chrome browser extension required"
                  : "Chrome browser extension needs updating",
              )}
            </div>
            <div {...stylex.props(inlineStyles.inline29)}>
              {t(
                "Download the ZIP, extract it, then open Chrome Extensions, enable Developer mode, and choose Load unpacked.",
              )}
            </div>
          </div>
          <ol {...stylex.props(inlineStyles.inline30)}>
            <li>{t("Download and extract the browser extension ZIP.")}</li>
            <li>{t("Open chrome://extensions and enable Developer mode.")}</li>
            <li>{t("Choose Load unpacked and select the extracted folder.")}</li>
          </ol>
          <div {...stylex.props(inlineStyles.inline31)}>
            <button type="button" onClick={openChromeInstallationGuide} style={buttonStyle()}>
              {t("Open installation guide")}
            </button>
            <a
              href={apiUrls.packages.downloadChromeExtension()}
              download={`pi-chrome-extension-${pkg.chromeExtensionDisplayVersion ?? pkg.version ?? "latest"}.zip`}
              style={{
                ...buttonStyle(),
                background: "var(--accent)",
                borderColor: "var(--accent)",
                color: "white",
                textDecoration: "none",
              }}
            >
              {t("Download browser extension ZIP")}
            </a>
          </div>
        </div>
      )}
      {isWeixin && (
        <div data-weixin-global-status {...stylex.props(inlineStyles.inline32)}>
          <div {...stylex.props(inlineStyles.inline33)}>{t("Global Weixin status")}</div>
          <div {...stylex.props(inlineStyles.inline34)}>{t("Connection")}</div>
          <div>{weixinStatus?.phase ?? t("Unavailable until a session loads")}</div>
          <div {...stylex.props(inlineStyles.inline35)}>{t("Account")}</div>
          <div {...stylex.props(inlineStyles.inline36)}>{weixinStatus?.accountId ?? t("Not logged in")}</div>
          <div {...stylex.props(inlineStyles.inline37)}>{t("Default session")}</div>
          <div {...stylex.props(inlineStyles.inline38)}>{weixinStatus?.defaultSessionId ?? t("Not configured")}</div>
          <div {...stylex.props(inlineStyles.inline39)}>{t("Proactive send")}</div>
          <div>{weixinStatus?.sendReady ? t("Ready") : t("Waiting for an inbound Weixin message")}</div>
          {weixinStatus?.error && <div {...stylex.props(inlineStyles.inline40)}>{weixinStatus.error}</div>}
        </div>
      )}
      <div {...stylex.props(inlineStyles.inline41)}>
        <div {...stylex.props(inlineStyles.inline42)}>
          <Toggle
            enabled={enabled}
            loading={busy || reloadBusy}
            onToggle={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={t(pkg.disabled ? "Enable package" : "Disable package")}
          />
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span {...stylex.props(inlineStyles.inline43)}>disabled</span>
          ) : (
            pkg.filtered && <span {...stylex.props(inlineStyles.inline44)}>filtered</span>
          )}
          <span {...stylex.props(inlineStyles.inline45)}>{pkg.source}</span>
        </div>

        <div {...stylex.props(inlineStyles.inline46)}>
          <button
            onClick={() => onAction("update", pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy)}
          >
            {t(busyKey === `update:${key}` ? "Updating..." : "Update")}
          </button>
          <button
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
            style={buttonStyle(!sessionId || reloadBusy || busy)}
            title={sessionId ? t("Reload current session") : t("Open a session to reload")}
          >
            {t(reloadBusy ? "Reloading..." : "Reload session")}
          </button>
          <button
            onClick={() => onAction("remove", pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy, true)}
          >
            {t(busyKey === `remove:${key}` ? "Removing..." : "Remove")}
          </button>
        </div>
      </div>

      <div {...stylex.props(inlineStyles.inline47)}>
        <div {...stylex.props(inlineStyles.inline48)}>{t("Status")}</div>
        <div
          {...stylex.props(inlineStyles.inline49)}
          style={{
            color: statusColor(pkg.status),
          }}
        >
          {pkg.status}
        </div>
        <div {...stylex.props(inlineStyles.inline50)}>{t("Version")}</div>
        <div {...stylex.props(inlineStyles.inline51)}>{versionSummary(pkg)}</div>
        <div {...stylex.props(inlineStyles.inline52)}>{t("Package")}</div>
        <div {...stylex.props(inlineStyles.inline53)}>{pkg.packageName ?? t("Unknown")}</div>
        <div {...stylex.props(inlineStyles.inline54)}>{t("Resources")}</div>
        <div {...stylex.props(inlineStyles.inline55)}>{resourceSummary(pkg)}</div>
        <div {...stylex.props(inlineStyles.inline56)}>{t("Installed path")}</div>
        <div
          {...stylex.props(inlineStyles.inline57)}
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "#ef4444",
          }}
        >
          {pkg.installedPath ? shortenPath(pkg.installedPath) : t("Not found")}
        </div>
        {cwd !== null && <div {...stylex.props(inlineStyles.inline58)}>CWD</div>}
        {cwd !== null && <div {...stylex.props(inlineStyles.inline59)}>{shortenPath(cwd)}</div>}
      </div>

      <div {...stylex.props(inlineStyles.inline60)}>
        <div {...stylex.props(inlineStyles.inline61)}>Resolved Resources</div>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && <div {...stylex.props(inlineStyles.inline62)}>{actionMessage}</div>}
      {actionError && <div {...stylex.props(inlineStyles.inline63)}>{actionError}</div>}
    </div>
  )
}
export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  initialPackageName,
  chromeHealth,
  weixinStatus,
  presentation = "dialog",
  onOpenPackage,
  openablePackageNames,
  projectCwds = [],
}: {
  cwd: string | null
  sessionId: string | null
  onClose: () => void
  onReloaded?: () => void
  initialPackageName?: string
  chromeHealth: ChromeExtensionHealth | null
  weixinStatus: WeixinStatusProjection | undefined
  presentation?: "dialog" | "page"
  onOpenPackage?: (packageName: string) => void
  openablePackageNames?: ReadonlySet<string>
  projectCwds?: ReadonlyArray<string>
}) {
  const { t, locale } = useI18n()
  const isMobile = useIsMobile()
  const [data, setData] = useState<PluginsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [installSource, setInstallSource] = useState("")
  const [installScope, setInstallScope] = useState<PluginScope>("global")
  const [installProjectCwd, setInstallProjectCwd] = useState<string | null>(projectCwds[0] ?? null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [pageQuery, setPageQuery] = useState("")
  const packages = useMemo(() => data?.packages ?? [], [data?.packages])
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null
  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({
        scope,
        packages: packages.filter((pkg) => pkg.scope === scope),
      }))
      .filter((group) => group.packages.length > 0)
  }, [packages])
  const loadPlugins = useCallback(() => {
    setLoading(true)
    setError(null)
    const request =
      presentation === "page"
        ? withApi((api) => api.packages.pluginOverview())
        : cwd === null
          ? withApi((api) => api.packages.globalPlugins())
          : withApi((api) =>
              api.packages.plugins({
                query: {
                  cwd,
                },
              }),
            )
    runApi(request, {
      onSuccess: (response) => {
        const next = clonePlugins(response)
        setData(next)
        setAddMode((current) => next.packages.length === 0 || current)
        setSelected((current) => {
          if (current && next.packages.some((pkg) => packageKey(pkg) === current)) return current
          const initial = next.packages.find((pkg) => pkg.packageName === initialPackageName)
          return initial ? packageKey(initial) : next.packages[0] ? packageKey(next.packages[0]) : null
        })
        setLoading(false)
      },
      onFailure: (failure) => {
        setError(failure instanceof Error ? failure.message : String(failure))
        setLoading(false)
      },
    })
  }, [cwd, initialPackageName, presentation])
  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])
  useEffect(() => {
    setInstallProjectCwd((current) =>
      current !== null && projectCwds.includes(current) ? current : (projectCwds[0] ?? null),
    )
  }, [projectCwds])
  const runAction = useCallback(
    (action: PluginAction, pkg: PluginPackageInfo) => {
      const key = packageKey(pkg)
      setBusyKey(`${action}:${key}`)
      setActionError(null)
      setActionMessage(null)
      const actionCwd = presentation === "page" ? (pkg.ownerCwd ?? null) : cwd
      runApi(
        withApi((api) =>
          api.packages.pluginAction({
            payload: {
              action,
              source: pkg.source,
              scope: pkg.scope,
              ...(actionCwd === null
                ? {}
                : {
                    cwd: actionCwd,
                  }),
            },
          }),
        ),
        {
          onSuccess: (response) => {
            if (presentation === "page") {
              setBusyKey(null)
              setActionMessage(action === "remove" ? "Package removed." : `Package ${action}d.`)
              loadPlugins()
              onReloaded?.()
              return
            }
            const next = clonePlugins(response)
            setData(next)
            if (action === "remove") {
              setSelected(next.packages[0] ? packageKey(next.packages[0]) : null)
              if (next.packages.length === 0) setAddMode(true)
              setActionMessage("Package removed.")
            } else {
              const messages: Record<Exclude<PluginAction, "remove">, string> = {
                install: "Package installed.",
                update: "Package updated.",
                disable: "Package disabled.",
                enable: "Package enabled.",
              }
              setActionMessage(messages[action])
            }
            setBusyKey(null)
            onReloaded?.()
          },
          onFailure: (failure) => {
            setActionError(failure instanceof Error ? failure.message : String(failure))
            setBusyKey(null)
          },
        },
      )
    },
    [cwd, loadPlugins, onReloaded, presentation],
  )
  const installPlugin = useCallback(() => {
    const source = installSource.trim()
    if (!source) return
    const key = `${installScope}\0${source}`
    setBusyKey(`install:${key}`)
    setActionError(null)
    setActionMessage(null)
    const installCwd = installScope === "project" ? installProjectCwd : presentation === "page" ? null : cwd
    if (installScope === "project" && installCwd === null) return
    runApi(
      withApi((api) =>
        api.packages.pluginAction({
          payload: {
            action: "install",
            source,
            scope: installScope,
            ...(installCwd === null
              ? {}
              : {
                  cwd: installCwd,
                }),
          },
        }),
      ),
      {
        onSuccess: (response) => {
          if (presentation === "page") {
            setAddMode(false)
            setInstallSource("")
            setActionMessage("Package installed.")
            setBusyKey(null)
            loadPlugins()
            onReloaded?.()
            return
          }
          const next = clonePlugins(response)
          setData(next)
          const installed = findInstalledPackage(next.packages, source, installScope)
          setSelected(installed ? packageKey(installed) : key)
          setAddMode(false)
          setInstallSource("")
          setActionMessage("Package installed.")
          setBusyKey(null)
          onReloaded?.()
        },
        onFailure: (failure) => {
          setActionError(failure instanceof Error ? failure.message : String(failure))
          setBusyKey(null)
        },
      },
    )
  }, [cwd, installProjectCwd, installScope, installSource, loadPlugins, onReloaded, presentation])
  const reloadSession = useCallback(() => {
    if (!sessionId) return
    setBusyKey("reload")
    setActionError(null)
    setActionMessage(null)
    runApi(
      withApi((api) =>
        api.sessionActions.reload({
          params: {
            id: sessionId,
          },
          payload: {},
        }),
      ),
      {
        onSuccess: () => {
          onReloaded?.()
          loadPlugins()
          setActionMessage("Session reloaded.")
          setBusyKey(null)
        },
        onFailure: (failure) => {
          setActionError(failure instanceof Error ? failure.message : String(failure))
          setBusyKey(null)
        },
      },
    )
  }, [loadPlugins, onReloaded, sessionId])
  const addBusy = busyKey?.startsWith("install:") ?? false
  const hasUpdate = (pkg: PluginPackageInfo) =>
    pkg.version !== undefined && pkg.configuredVersion !== undefined && pkg.version !== pkg.configuredVersion
  const visiblePackages = packages.filter((pkg) => {
    const query = pageQuery.trim().toLowerCase()
    return query.length === 0 || `${pkg.packageName ?? ""} ${pkg.source}`.toLowerCase().includes(query)
  })
  if (presentation === "page") {
    const activeCount = packages.filter((pkg) => !pkg.disabled).length
    return (
      <div {...stylex.props(inlineStyles.page)}>
        <header {...stylex.props(inlineStyles.pageHeader)}>
          <div>
            <h2 {...stylex.props(inlineStyles.pageTitle)}>拓展</h2>
            <p {...stylex.props(inlineStyles.pageSubtitle)}>
              已激活 {activeCount} / {packages.length} · 当前设备
            </p>
          </div>
        </header>
        <main {...stylex.props(inlineStyles.pageBody)}>
          <div {...stylex.props(inlineStyles.pageToolbar)}>
            <label {...stylex.props(inlineStyles.pageSearch)}>
              <svg
                aria-hidden="true"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                value={pageQuery}
                onChange={(event) => setPageQuery(event.target.value)}
                placeholder="搜索拓展…"
                {...stylex.props(inlineStyles.pageSearchInput)}
              />
            </label>
            <button {...stylex.props(inlineStyles.pagePrimary)} onClick={() => setAddMode(true)}>
              ＋ 添加
            </button>
          </div>
          <section {...stylex.props(inlineStyles.pageList)}>
            {loading ? (
              <div {...stylex.props(inlineStyles.pageEmpty)}>{t("Loading...")}</div>
            ) : error ? (
              <div {...stylex.props(inlineStyles.pageError)}>{error}</div>
            ) : visiblePackages.length === 0 ? (
              <div {...stylex.props(inlineStyles.pageEmpty)}>没有符合条件的拓展</div>
            ) : (
              visiblePackages.map((pkg) => {
                const displayName = packageDisplayName(pkg)
                const actionable =
                  pkg.packageName !== undefined &&
                  onOpenPackage !== undefined &&
                  (openablePackageNames === undefined || openablePackageNames.has(pkg.packageName))
                const busy = busyKey !== null && busyKey.endsWith(packageKey(pkg))
                return (
                  <article
                    key={packageKey(pkg)}
                    tabIndex={actionable ? 0 : undefined}
                    role={actionable ? "link" : undefined}
                    {...stylex.props(inlineStyles.pageRow, !pkg.disabled && inlineStyles.pageRowActive)}
                    style={{ cursor: actionable ? "pointer" : "default" }}
                    onClick={() => actionable && pkg.packageName && onOpenPackage?.(pkg.packageName)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        event.target === event.currentTarget &&
                        actionable &&
                        pkg.packageName
                      ) {
                        onOpenPackage?.(pkg.packageName)
                      }
                    }}
                  >
                    <span {...stylex.props(inlineStyles.pageLogo)}>{displayName.slice(0, 1).toUpperCase()}</span>
                    <div {...stylex.props(inlineStyles.pageMain)}>
                      <div {...stylex.props(inlineStyles.pageName)}>
                        <h3 {...stylex.props(inlineStyles.pagePackageTitle)}>{displayName}</h3>
                        {hasUpdate(pkg) && <span {...stylex.props(inlineStyles.pageUpdate)}>可更新</span>}
                      </div>
                      <div {...stylex.props(inlineStyles.pageSummary)}>
                        <span {...stylex.props(inlineStyles.pageMetaItem)}>{packageSubtitle(pkg)}</span>
                      </div>
                    </div>
                    <div {...stylex.props(inlineStyles.pageActions)} onClick={(event) => event.stopPropagation()}>
                      <span {...stylex.props(inlineStyles.pageState, !pkg.disabled && inlineStyles.pageStateActive)}>
                        {pkg.disabled ? "已禁用" : "已启用"}
                      </span>
                      {hasUpdate(pkg) && (
                        <button
                          title="立即更新"
                          aria-label={`更新 ${displayName}`}
                          {...stylex.props(inlineStyles.pageIconButton, inlineStyles.pageUpdateButton)}
                          disabled={busy}
                          onClick={() => runAction("update", pkg)}
                        >
                          <RefreshIcon />
                        </button>
                      )}
                      {pkg.disabled && (
                        <button
                          title="删除插件"
                          aria-label={`删除 ${displayName}`}
                          {...stylex.props(inlineStyles.pageIconButton, inlineStyles.pageDeleteButton)}
                          disabled={busy}
                          onClick={() => runAction("remove", pkg)}
                        >
                          <TrashIcon />
                        </button>
                      )}
                      <Toggle
                        enabled={!pkg.disabled}
                        loading={busy}
                        label={`${pkg.disabled ? "激活" : "禁用"} ${displayName}`}
                        onToggle={() => runAction(pkg.disabled ? "enable" : "disable", pkg)}
                      />
                      {actionable && (
                        <svg
                          aria-hidden="true"
                          width="11"
                          height="11"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          {...stylex.props(inlineStyles.pageChevron)}
                        >
                          <polyline points="4 2.5 7.5 6 4 9.5" />
                        </svg>
                      )}
                    </div>
                  </article>
                )
              })
            )}
          </section>
          <footer {...stylex.props(inlineStyles.pageFootnote)}>
            <span>安装与启用状态来自 plugin overview</span>
            <span>独立 UI 来自当前 session runtime</span>
          </footer>
          {actionMessage && <div {...stylex.props(inlineStyles.inline62)}>{actionMessage}</div>}
          {actionError && <div {...stylex.props(inlineStyles.inline63)}>{actionError}</div>}
        </main>
        {addMode && (
          <div {...stylex.props(inlineStyles.pageOverlay)} onClick={() => setAddMode(false)}>
            <div {...stylex.props(inlineStyles.pageAddModal)} onClick={(event) => event.stopPropagation()}>
              <div {...stylex.props(inlineStyles.pageAddBody)}>
                <AddPluginPanel
                  cwd={presentation === "page" ? installProjectCwd : cwd}
                  projectCwds={projectCwds}
                  projectCwd={installProjectCwd}
                  source={installSource}
                  scope={installScope}
                  busy={addBusy}
                  actionError={actionError}
                  onSourceChange={setInstallSource}
                  onScopeChange={setInstallScope}
                  onProjectCwdChange={setInstallProjectCwd}
                  onInstall={installPlugin}
                  onClose={() => setAddMode(false)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
  return (
    <SettingsWorkspace
      closeLabel={t("Close")}
      context={
        <code {...stylex.props(inlineStyles.inline69)}>{cwd === null ? t("Global packages") : shortenPath(cwd)}</code>
      }
      height={isMobile ? "calc(100dvh - 16px)" : "76vh"}
      onClose={onClose}
      title={t("Plugins")}
      width={isMobile ? "calc(100vw - 16px)" : 860}
    >
      <div
        {...stylex.props(inlineStyles.inline71)}
        style={{
          flexDirection: isMobile ? "column" : "row",
        }}
      >
        <div
          {...stylex.props(inlineStyles.inline72)}
          style={{
            width: isMobile ? "100%" : 245,
            maxHeight: isMobile ? "40vh" : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: isMobile ? "1px solid var(--border)" : "none",
          }}
        >
          <div {...stylex.props(inlineStyles.inline73)}>
            {loading ? (
              <div {...stylex.props(inlineStyles.inline74)}>{t("Loading...")}</div>
            ) : error ? (
              <div {...stylex.props(inlineStyles.inline75)}>{error}</div>
            ) : packages.length === 0 ? (
              <div {...stylex.props(inlineStyles.inline76)}>{t("No plugins configured")}</div>
            ) : (
              groupedPackages.map((group) => (
                <div key={group.scope} {...stylex.props(inlineStyles.inline77)}>
                  <div {...stylex.props(inlineStyles.inline78)}>{t(group.scope)}</div>
                  {group.packages.map((pkg) => {
                    const key = packageKey(pkg)
                    const isSelected = !addMode && selected === key
                    return (
                      <div
                        key={key}
                        onClick={() => {
                          setSelected(key)
                          setAddMode(false)
                          setActionError(null)
                          setActionMessage(null)
                        }}
                        {...stylex.props(inlineStyles.inline79)}
                        style={{
                          background: isSelected ? "var(--bg-selected)" : "none",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "none"
                        }}
                      >
                        <span
                          {...stylex.props(inlineStyles.inline80)}
                          style={{
                            background: statusColor(pkg.status),
                          }}
                        />
                        <div {...stylex.props(inlineStyles.inline81)}>
                          <div
                            {...stylex.props(inlineStyles.inline82)}
                            style={{
                              fontWeight: isSelected ? 600 : 400,
                            }}
                          >
                            {pkg.source}
                          </div>
                          <div {...stylex.props(inlineStyles.inline83)}>{resourceSummary(pkg)}</div>
                          {(pkg.version || pkg.configuredVersion) && (
                            <div {...stylex.props(inlineStyles.inline84)}>{versionSummary(pkg)}</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div {...stylex.props(inlineStyles.inline85)}>
            <button
              type="button"
              onClick={() => {
                setAddMode(true)
                setActionError(null)
                setActionMessage(null)
              }}
              {...stylex.props(inlineStyles.inline86)}
              style={{
                background: addMode ? "var(--bg-selected)" : "none",
                color: addMode ? "var(--accent)" : "var(--text-dim)",
              }}
              onMouseEnter={(e) => {
                if (!addMode) e.currentTarget.style.background = "var(--bg-hover)"
              }}
              onMouseLeave={(e) => {
                if (!addMode) e.currentTarget.style.background = "none"
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t("Add plugin")}
            </button>
          </div>
        </div>

        <div {...stylex.props(inlineStyles.inline87)}>
          {addMode ? (
            <AddPluginPanel
              cwd={cwd}
              source={installSource}
              scope={installScope}
              busy={addBusy}
              actionError={actionError}
              onSourceChange={setInstallSource}
              onScopeChange={setInstallScope}
              onInstall={installPlugin}
            />
          ) : loading ? null : selectedPackage ? (
            <PackageDetail
              key={packageKey(selectedPackage)}
              pkg={selectedPackage}
              cwd={cwd}
              busyKey={busyKey}
              actionError={actionError}
              actionMessage={actionMessage}
              sessionId={sessionId}
              onAction={runAction}
              onReloadSession={reloadSession}
              chromeHealth={chromeHealth}
              weixinStatus={weixinStatus}
            />
          ) : (
            <div {...stylex.props(inlineStyles.inline88)}>{t("Select a package")}</div>
          )}
        </div>
      </div>

      <div {...stylex.props(inlineStyles.inline89)}>
        <div {...stylex.props(inlineStyles.inline90)}>
          {data?.diagnostics.length ? (
            <span
              title={data.diagnostics
                .map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`)
                .join("\n")}
              style={{
                color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706",
              }}
            >
              {locale === "zh-CN"
                ? `${data.diagnostics.length} 条诊断`
                : `${data.diagnostics.length} diagnostic${data.diagnostics.length === 1 ? "" : "s"}`}
            </span>
          ) : (
            <span>
              {data
                ? `${data.totals.extensions} ext · ${data.totals.skills} skills · ${data.totals.prompts} prompts · ${data.totals.themes} themes`
                : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => loadPlugins()}
          disabled={loading || busyKey !== null}
          style={buttonStyle(loading || busyKey !== null)}
        >
          {t("Refresh")}
        </button>
        <button onClick={onClose} style={buttonStyle(false)}>
          {t("Close")}
        </button>
      </div>
    </SettingsWorkspace>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    fontSize: 12,
    color: "var(--text-dim)",
  },
  inline2: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  inline3: {
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  inline4: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  inline5: {
    minWidth: 0,
  },
  inline6: {
    fontSize: 12,
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline7: {
    fontSize: 10,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 1,
  },
  inline8: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 3,
    flexShrink: 0,
  },
  inline11: {
    display: "inline-flex",
    border: "1px solid var(--border)",
    borderRadius: 7,
    overflow: "hidden",
    height: 30,
  },
  inline12: {
    width: 76,
    border: "none",
    fontSize: 12,
  },
  inline13: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
    maxWidth: 660,
    minHeight: "100%",
  },
  inline14: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  addHeaderCopy: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 },
  inline15: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--text)",
  },
  inline16: {
    fontSize: 12,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
  },
  inline17: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
  },
  inline18: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
  },
  inline19: {
    width: "100%",
    height: 36,
    padding: "0 11px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    outline: "none",
  },
  inline20: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  inline21: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
  },
  inline22: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
  },
  inline23: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  inline24: {
    width: "100%",
    minHeight: 30,
    textAlign: "left",
    padding: "6px 9px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  },
  inline25: {
    fontSize: 12,
    color: "#ef4444",
    whiteSpace: "pre-wrap",
  },
  inline26: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    maxWidth: 680,
  },
  inline27: {
    padding: 16,
    border: "1px solid rgba(239,68,68,0.45)",
    borderRadius: 8,
    background: "rgba(239,68,68,0.07)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  inline28: {
    fontSize: 14,
    fontWeight: 700,
    color: "#ef4444",
  },
  inline29: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 1.55,
    color: "var(--text-muted)",
  },
  inline30: {
    margin: 0,
    paddingLeft: 20,
    fontSize: 12,
    lineHeight: 1.7,
    color: "var(--text-muted)",
  },
  inline31: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  inline32: {
    padding: 16,
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-secondary)",
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: "8px 14px",
    fontSize: 12,
  },
  inline33: {
    gridColumn: "1 / -1",
    fontSize: 14,
    fontWeight: 700,
  },
  inline34: {
    color: "var(--text-dim)",
  },
  inline35: {
    color: "var(--text-dim)",
  },
  inline36: {
    overflowWrap: "anywhere",
  },
  inline37: {
    color: "var(--text-dim)",
  },
  inline38: {
    overflowWrap: "anywhere",
    fontFamily: "var(--font-mono)",
  },
  inline39: {
    color: "var(--text-dim)",
  },
  inline40: {
    gridColumn: "1 / -1",
    color: "#ef4444",
    overflowWrap: "anywhere",
  },
  inline41: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    minWidth: 0,
    flexWrap: "wrap",
  },
  inline42: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 180,
    flex: 1,
  },
  inline43: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 3,
    background: "rgba(120,120,120,0.12)",
    color: "var(--text-dim)",
  },
  inline44: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 3,
    background: "rgba(245,158,11,0.12)",
    color: "#d97706",
  },
  inline45: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline46: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  inline47: {
    display: "grid",
    gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
    gap: "9px 14px",
    fontSize: 12,
    lineHeight: 1.45,
  },
  inline48: {
    color: "var(--text-dim)",
  },
  inline49: {
    textTransform: "capitalize",
  },
  inline50: {
    color: "var(--text-dim)",
  },
  inline51: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
  },
  inline52: {
    color: "var(--text-dim)",
  },
  inline53: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
  },
  inline54: {
    color: "var(--text-dim)",
  },
  inline55: {
    color: "var(--text-muted)",
  },
  inline56: {
    color: "var(--text-dim)",
  },
  inline57: {
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
  },
  inline58: {
    color: "var(--text-dim)",
  },
  inline59: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
  },
  inline60: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  inline61: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--text)",
  },
  inline62: {
    fontSize: 12,
    color: "#16a34a",
  },
  inline63: {
    fontSize: 12,
    color: "#ef4444",
    whiteSpace: "pre-wrap",
  },
  inline69: {
    fontSize: 11,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline71: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
  },
  inline72: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    background: "var(--bg-panel)",
  },
  inline73: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 6px",
  },
  inline74: {
    padding: "10px 8px",
    fontSize: 12,
    color: "var(--text-muted)",
  },
  inline75: {
    padding: "10px 8px",
    fontSize: 11,
    color: "#ef4444",
  },
  inline76: {
    padding: "10px 8px",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline77: {
    marginBottom: 6,
  },
  inline78: {
    padding: "4px 8px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-dim)",
    textTransform: "uppercase",
  },
  inline79: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 8px",
    borderRadius: 5,
    cursor: "pointer",
  },
  inline80: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: "50%",
  },
  inline81: {
    minWidth: 0,
    flex: 1,
  },
  inline82: {
    fontSize: 12,
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline83: {
    fontSize: 10,
    color: "var(--text-dim)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 2,
  },
  inline84: {
    fontSize: 10,
    color: "var(--text-dim)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 2,
  },
  inline85: {
    padding: "8px 6px",
    borderTop: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline86: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 8px",
    borderRadius: 5,
    border: "none",
    width: "100%",
    cursor: "pointer",
    fontSize: 12,
  },
  inline87: {
    flex: 1,
    overflowY: "auto",
    padding: 20,
  },
  inline88: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-dim)",
    fontSize: 13,
  },
  inline89: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 18px",
    borderTop: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline90: {
    minWidth: 0,
    flex: 1,
    fontSize: 11,
    color: "var(--text-dim)",
    overflow: "hidden",
  },
  page: {
    backgroundColor: "var(--bg-panel)",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  pageHeader: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexShrink: 0,
    justifyContent: "space-between",
    minHeight: 58,
    paddingLeft: 16,
    paddingRight: 62,
  },
  pageTitle: { fontSize: 14, margin: 0 },
  pageSubtitle: { color: "var(--text-muted)", fontSize: 11, marginBlock: 4 },
  pagePrimary: {
    alignItems: "center",
    backgroundColor: "var(--text)",
    border: "1px solid var(--text)",
    borderRadius: 7,
    color: "white",
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    fontSize: 12,
    height: 34,
    paddingInline: 10,
  },
  pageBody: { display: "flex", flex: 1, flexDirection: "column", minHeight: 0, overflow: "hidden" },
  pageToolbar: {
    alignItems: "center",
    borderBottom: "1px solid var(--border-soft)",
    display: "flex",
    flexShrink: 0,
    gap: 7,
    minHeight: 54,
    padding: "8px 10px",
  },
  pageSearch: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-dim)",
    display: "flex",
    gap: 7,
    height: 34,
    paddingInline: 10,
    flex: 1,
    minWidth: 0,
  },
  pageSearchInput: {
    backgroundColor: "transparent",
    border: 0,
    color: "var(--text)",
    flex: 1,
    fontSize: 12,
    minWidth: 0,
    outline: 0,
  },
  pageProjectSelect: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    height: 30,
    maxWidth: 240,
    paddingInline: 8,
  },
  pageList: {
    alignContent: "start",
    display: "grid",
    flex: 1,
    gap: 0,
    gridTemplateColumns: "minmax(0, 1fr)",
    gridAutoRows: "max-content",
    overflowY: "auto",
    padding: 10,
  },
  pageRow: {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "1px solid transparent",
    borderRadius: 9,
    cursor: "pointer",
    display: "grid",
    gap: 10,
    gridTemplateColumns: "32px minmax(0, 1fr) auto",
    minHeight: 60,
    overflow: "hidden",
    paddingBlock: 8,
    paddingInline: 9,
    position: "relative",
    ":hover": { backgroundColor: "var(--bg-hover)" },
  },
  pageRowActive: {
    backgroundColor: "transparent",
  },
  pageLogo: {
    alignItems: "center",
    backgroundColor: "var(--success-soft)",
    borderRadius: 9,
    color: "var(--success)",
    display: "flex",
    fontSize: 10,
    fontWeight: 800,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  pageMain: {
    display: "grid",
    gridTemplateAreas: '"name" "summary"',
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    rowGap: 3,
  },
  pageName: { alignItems: "center", display: "flex", gap: 7, gridArea: "name", whiteSpace: "nowrap" },
  pagePackageTitle: { fontSize: 13, margin: 0 },
  pageState: {
    color: "var(--text-muted)",
    flexShrink: 0,
    fontSize: 11,
  },
  pageStateActive: { color: "var(--success)" },
  pageUpdate: {
    backgroundColor: "rgba(245,158,11,.12)",
    borderRadius: 999,
    color: "#d97706",
    fontSize: 10,
    fontWeight: 700,
    paddingBlock: 3,
    paddingInline: 6,
  },
  pageSummary: {
    alignItems: "center",
    display: "flex",
    gridArea: "summary",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
  },
  pageMetaItem: {
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  pageActions: { alignItems: "center", display: "flex", flexShrink: 0, gap: 7 },
  pageChevron: { color: "var(--text-dim)", flexShrink: 0 },
  pageIconButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "1px solid transparent",
    borderRadius: 8,
    cursor: "pointer",
    display: "flex",
    height: 30,
    justifyContent: "center",
    padding: 0,
    width: 30,
  },
  pageUpdateButton: { color: "var(--text-muted)" },
  pageDeleteButton: { color: "#ef4444" },
  pageEmpty: { color: "var(--text-muted)", padding: 46, textAlign: "center" },
  pageError: { color: "#ef4444", padding: 20 },
  pageFootnote: {
    borderTop: "1px solid var(--border-soft)",
    color: "var(--text-muted)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    fontSize: 10,
    gap: 3,
    padding: "10px 15px",
  },
  pageOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,.4)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    padding: 20,
    position: "fixed",
    zIndex: 1000,
  },
  pageAddModal: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    boxShadow: "0 24px 80px rgba(0,0,0,.22)",
    maxHeight: "calc(100dvh - 40px)",
    overflow: "auto",
    width: "min(560px, 100%)",
  },
  pageAddHead: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    fontSize: 15,
    fontWeight: 700,
    justifyContent: "space-between",
    minHeight: 58,
    paddingInline: 18,
  },
  pageCloseButton: {
    backgroundColor: "transparent",
    border: 0,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 20,
  },
  pageAddBody: { padding: 20 },
})
