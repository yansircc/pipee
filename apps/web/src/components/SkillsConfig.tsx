import * as stylex from "@stylexjs/stylex"
import { useState, useEffect, useCallback, useRef } from "react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useTheme } from "@/hooks/useTheme"
import type { SkillSearchResult } from "@/api/contract"
import { useI18n } from "@/lib/i18n"
import { copyText } from "@/lib/clipboard"
import { withApi, runApi, runBrowser } from "@/browser/api-client"
import { SettingsToggle as Toggle } from "@/ui/interaction/SettingsToggle"
import { SettingsWorkspace } from "@/ui/interaction/SettingsWorkspace"
interface Skill {
  name: string
  description: string
  filePath: string
  baseDir: string
  disableModelInvocation: boolean
  sourceInfo: {
    source?: string
    scope?: string
  }
}
function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~")
}
function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source
  const scope = skill.sourceInfo?.scope
  if (scope === "user" || src === "user") return "global"
  if (scope === "project" || src === "project") return "project"
  return "path"
}
function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
  onDelete,
  deleting,
}: {
  skill: Skill
  cwd: string
  onToggle: (skill: Skill) => void
  toggling: boolean
  saveError: string | null
  onDelete: (skill: Skill) => void
  deleting: boolean
}) {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const isMobile = useIsMobile()
  const label = sourceLabel(skill)
  const enabled = !skill.disableModelInvocation
  const [files, setFiles] = useState<Array<{ path: string; name: string; kind: "file" | "directory"; size: number }>>(
    [],
  )
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "")
      return `./${rel}`
    }
    return shortenPath(p)
  }
  useEffect(() => {
    setFiles([])
    setSelectedFile(null)
    setContent(null)
    setFileError(null)
    return runApi(
      withApi((api) => api.packages.skillFiles({ query: { cwd, skillPath: skill.filePath } })),
      {
        onSuccess: ({ entries }) => {
          const ordered = [...entries].sort(
            (left, right) =>
              Number(right.kind === "directory") - Number(left.kind === "directory") ||
              left.path.localeCompare(right.path),
          )
          setFiles(ordered)
          const first =
            ordered.find((entry) => entry.kind === "file" && entry.path.toLowerCase() === "skill.md") ??
            ordered.find((entry) => entry.kind === "file")
          setSelectedFile(first?.path ?? null)
        },
        onFailure: (failure) => setFileError(String(failure)),
      },
    )
  }, [cwd, skill.filePath])
  useEffect(() => {
    if (selectedFile === null) return
    setContent(null)
    setFileError(null)
    return runApi(
      withApi((api) => api.packages.skillFile({ query: { cwd, skillPath: skill.filePath, path: selectedFile } })),
      {
        onSuccess: (file) => setContent(file.content),
        onFailure: (failure) => setFileError(String(failure)),
      },
    )
  }, [cwd, selectedFile, skill.filePath])
  const language = (() => {
    const ext = selectedFile?.split(".").pop()?.toLowerCase()
    return ext === "md"
      ? "markdown"
      : ext === "ts" || ext === "tsx"
        ? "typescript"
        : ext === "js"
          ? "javascript"
          : (ext ?? "text")
  })()
  return (
    <div
      {...stylex.props(inlineStyles.skillFinder)}
      style={{ gridTemplateColumns: isMobile ? "1fr" : "180px minmax(0, 1fr) 220px" }}
    >
      <aside {...stylex.props(inlineStyles.skillFileTree)}>
        <div {...stylex.props(inlineStyles.skillPaneTitle)}>
          FILES · {files.filter((file) => file.kind === "file").length}
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            disabled={file.kind === "directory"}
            aria-current={selectedFile === file.path ? "true" : undefined}
            onClick={() => file.kind === "file" && setSelectedFile(file.path)}
            {...stylex.props(inlineStyles.skillFileRow)}
            style={{
              background: selectedFile === file.path ? "var(--bg-selected)" : "transparent",
              paddingLeft: 8 + Math.max(0, file.path.split("/").length - 1) * 10,
            }}
          >
            <span>{file.kind === "directory" ? "▸" : "·"}</span>
            <span>{file.path}</span>
          </button>
        ))}
      </aside>
      <section {...stylex.props(inlineStyles.skillPreview)}>
        <header {...stylex.props(inlineStyles.skillPreviewHeader)}>
          <code>{selectedFile ?? t("Select a file")}</code>
          {content !== null && (
            <button type="button" onClick={() => runBrowser(copyText(content), { onSuccess: () => undefined })}>
              {t("Copy")}
            </button>
          )}
        </header>
        <div {...stylex.props(inlineStyles.skillPreviewBody)}>
          {fileError ? (
            <div {...stylex.props(inlineStyles.inline7)}>{fileError}</div>
          ) : content === null ? (
            <div {...stylex.props(inlineStyles.inline58)}>{t("Loading…")}</div>
          ) : (
            <SyntaxHighlighter
              language={language}
              style={isDark ? vscDarkPlus : vs}
              showLineNumbers
              customStyle={{ margin: 0, minHeight: "100%", fontSize: 12, background: "var(--bg)" }}
            >
              {content}
            </SyntaxHighlighter>
          )}
        </div>
      </section>
      <aside {...stylex.props(inlineStyles.skillInspector)}>
        <div {...stylex.props(inlineStyles.skillPaneTitle)}>INSPECTOR</div>
        <strong>{skill.name}</strong>
        <p {...stylex.props(inlineStyles.skillDescription)}>{skill.description}</p>
        <span {...stylex.props(inlineStyles.inline5)}>{label}</span>
        <code {...stylex.props(inlineStyles.skillPath)}>{displayPath(skill.filePath)}</code>
        <div {...stylex.props(inlineStyles.skillToggleRow)}>
          <span>{t("Model invocation")}</span>
          <Toggle
            enabled={enabled}
            label={t(
              enabled ? "Visible in model prompt — click to disable" : "Hidden from model prompt — click to enable",
            )}
            loading={toggling}
            onToggle={() => onToggle(skill)}
          />
        </div>
        {saveError && <span {...stylex.props(inlineStyles.inline7)}>{saveError}</span>}
        {label !== "path" &&
          (confirmDelete ? (
            <div {...stylex.props(inlineStyles.deleteConfirm)}>
              <span>{t("Delete skill")}? </span>
              <button type="button" onClick={() => onDelete(skill)} disabled={deleting}>
                {t("Delete")}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                {t("Cancel")}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} {...stylex.props(inlineStyles.deleteSkill)}>
              {t("Delete skill")}
            </button>
          ))}
      </aside>
    </div>
  )
}
function AddSkillPanel({ cwd, onInstalled }: { cwd: string; onInstalled: () => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<"global" | "project">("global")
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const search = useCallback((q: string) => {
    if (!q.trim()) return
    setSearching(true)
    setSearchError(null)
    setResults([])
    runApi(
      withApi((api) =>
        api.packages.searchSkills({
          payload: {
            query: q.trim(),
          },
        }),
      ),
      {
        onSuccess: ({ results: values }) => {
          const results = values.map((result) => ({
            ...result,
          }))
          setResults(results)
          if (results.length === 0) setSearchError("No skills found")
          setSearching(false)
        },
        onFailure: (failure) => {
          setSearchError(String(failure))
          setSearching(false)
        },
      },
    )
    if (!q.trim()) {
      setSearching(false)
    }
  }, [])
  const install = useCallback(
    (pkg: string) => {
      setInstalling(pkg)
      setInstallError(null)
      const operation =
        scope === "global"
          ? withApi((api) =>
              api.packages.installSkill({
                payload: {
                  package: pkg,
                  scope,
                },
              }),
            )
          : withApi((api) =>
              api.packages.installSkill({
                payload: {
                  package: pkg,
                  scope,
                  cwd,
                },
              }),
            )
      runApi(operation, {
        onSuccess: () => {
          setInstalledPkgs((prev) => new Set(prev).add(pkg))
          onInstalled()
          setInstalling(null)
        },
        onFailure: (failure) => {
          setInstallError(String(failure))
          setInstalling(null)
        },
      })
    },
    [onInstalled, scope, cwd],
  )
  const installPath = scope === "global" ? "~/.pi/agent/skills/" : `${shortenPath(cwd)}/.pi/agent/skills/`
  return (
    <div {...stylex.props(inlineStyles.inline14)}>
      {/* ── Header area ── */}
      <div {...stylex.props(inlineStyles.inline15)}>
        <div {...stylex.props(inlineStyles.inline16)}>Add Skill</div>

        {/* Search row */}
        <div {...stylex.props(inlineStyles.inline17)}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query)
            }}
            placeholder="e.g. react, testing, deploy"
            {...stylex.props(inlineStyles.inline18)}
          />
          <button
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
            {...stylex.props(inlineStyles.inline19)}
            style={{
              cursor: searching || !query.trim() ? "not-allowed" : "pointer",
              opacity: searching || !query.trim() ? 0.5 : 1,
            }}
          >
            {t(searching ? "Searching…" : "Search")}
          </button>
        </div>

        {/* Scope + install path row */}
        <div {...stylex.props(inlineStyles.inline20)}>
          <div {...stylex.props(inlineStyles.inline21)}>
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                {...stylex.props(inlineStyles.inline22)}
                style={{
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  fontWeight: scope === s ? 600 : 400,
                  borderRight: s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <span {...stylex.props(inlineStyles.inline23)}>→ {installPath}</span>
        </div>

        {/* Errors */}
        {searchError && <div {...stylex.props(inlineStyles.inline24)}>{searchError}</div>}
        {installError && <div {...stylex.props(inlineStyles.inline25)}>{installError}</div>}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div {...stylex.props(inlineStyles.inline26)}>
          {results.map((r) => {
            const isInstalled = installedPkgs.has(r.package)
            const isInstalling = installing === r.package
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@")
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null
            return (
              <div key={r.package} {...stylex.props(inlineStyles.inline27)}>
                <div {...stylex.props(inlineStyles.inline28)}>
                  {/* skill name prominent */}
                  <div {...stylex.props(inlineStyles.inline29)}>{skillpart ?? repopart}</div>
                  {/* repo + installs + link row */}
                  <div {...stylex.props(inlineStyles.inline30)}>
                    <span {...stylex.props(inlineStyles.inline31)}>{repopart}</span>
                    <span {...stylex.props(inlineStyles.inline32)}>{r.installs}</span>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" {...stylex.props(inlineStyles.inline33)}>
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => !isInstalled && !isInstalling && install(r.package)}
                  disabled={isInstalled || isInstalling || installing !== null}
                  {...stylex.props(inlineStyles.inline34)}
                  style={{
                    cursor: isInstalled || isInstalling || installing !== null ? "not-allowed" : "pointer",
                    background: isInstalled ? "rgba(34,197,94,0.1)" : "none",
                    color: isInstalled ? "#16a34a" : isInstalling ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {isInstalled ? "✓ Installed" : isInstalling ? t("Installing…") : t("Install")}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div {...stylex.props(inlineStyles.inline35)}>
            Search{" "}
            <a href="https://skills.sh" target="_blank" rel="noreferrer" {...stylex.props(inlineStyles.inline36)}>
              skills.sh
            </a>{" "}
            to discover and install skills for your agent.
          </div>
        )
      )}
    </div>
  )
}
export function SkillsConfig({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [toggling, setToggling] = useState<Set<string>>(new Set())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [skillQuery, setSkillQuery] = useState("")
  const [scopeFilter, setScopeFilter] = useState<"all" | "project" | "global" | "path">("all")
  const loadSkills = useCallback(() => {
    setLoading(true)
    setError(null)
    runApi(
      withApi((api) =>
        api.packages.skills({
          query: {
            cwd,
          },
        }),
      ),
      {
        onSuccess: ({ skills: values }) => {
          const list = values.map((skill) => ({
            ...skill,
            sourceInfo: {
              ...skill.sourceInfo,
            },
          }))
          setSkills(list)
          if (list.length > 0 && !selected) setSelected(list[0].filePath)
          setLoading(false)
        },
        onFailure: (failure) => {
          setError(String(failure))
          setLoading(false)
        },
      },
    )
  }, [cwd, selected])
  useEffect(() => {
    loadSkills()
  }, [cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(
    (skill: Skill) => {
      const next = !skill.disableModelInvocation
      setToggling((s) => new Set(s).add(skill.filePath))
      setSaveError(null)
      runApi(
        withApi((api) =>
          api.packages.toggleSkill({
            payload: {
              cwd,
              filePath: skill.filePath,
              disableModelInvocation: next,
            },
          }),
        ),
        {
          onSuccess: () => {
            setSkills((prev) =>
              prev.map((s) =>
                s.filePath === skill.filePath
                  ? {
                      ...s,
                      disableModelInvocation: next,
                    }
                  : s,
              ),
            )
            setToggling((current) => {
              const updated = new Set(current)
              updated.delete(skill.filePath)
              return updated
            })
          },
          onFailure: (failure) => {
            setSaveError(String(failure))
            setToggling((s) => {
              const n = new Set(s)
              n.delete(skill.filePath)
              return n
            })
          },
        },
      )
    },
    [cwd],
  )
  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null
  const visibleSkills = skills.filter((skill) => {
    const query = skillQuery.trim().toLowerCase()
    const matchesScope = scopeFilter === "all" || sourceLabel(skill) === scopeFilter
    return (
      matchesScope &&
      (query.length === 0 || `${skill.name} ${skill.description} ${skill.filePath}`.toLowerCase().includes(query))
    )
  })
  const deleteSkill = useCallback(
    (skill: Skill) => {
      if (deleting !== null) return
      setDeleting(skill.filePath)
      setSaveError(null)
      runApi(
        withApi((api) => api.packages.deleteSkill({ payload: { cwd, filePath: skill.filePath } })),
        {
          onSuccess: () => {
            setDeleting(null)
            setSelected(null)
            loadSkills()
          },
          onFailure: (failure) => {
            setDeleting(null)
            setSaveError(String(failure))
          },
        },
      )
    },
    [cwd, deleting, loadSkills],
  )
  return (
    <SettingsWorkspace
      closeLabel={t("Close")}
      context={<code {...stylex.props(inlineStyles.inline42)}>{shortenPath(cwd)}</code>}
      height={isMobile ? "calc(100dvh - 16px)" : "82vh"}
      onClose={onClose}
      title={t("Skills")}
      width={isMobile ? "calc(100vw - 16px)" : 1180}
    >
      <div
        {...stylex.props(inlineStyles.inline44)}
        style={{
          flexDirection: isMobile ? "column" : "row",
        }}
      >
        {/* Left: skill list */}
        <div
          {...stylex.props(inlineStyles.inline45)}
          style={{
            width: isMobile ? "100%" : 250,
            maxHeight: isMobile ? "40vh" : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: isMobile ? "1px solid var(--border)" : "none",
          }}
        >
          <div {...stylex.props(inlineStyles.skillSummary)}>
            <strong>{skills.length}</strong>
            <span>{t("Skills")}</span>
            <span>
              {skills.filter((skill) => !skill.disableModelInvocation).length} {t("Enabled")}
            </span>
            <span>
              {skills.filter((skill) => skill.disableModelInvocation).length} {t("Disabled")}
            </span>
          </div>
          <div {...stylex.props(inlineStyles.skillFilters)}>
            {(["all", "project", "global", "path"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={scopeFilter === scope}
                onClick={() => setScopeFilter(scope)}
                style={{ background: scopeFilter === scope ? "var(--bg-selected)" : "transparent" }}
              >
                {t(scope)}
              </button>
            ))}
          </div>
          <div {...stylex.props(inlineStyles.skillSearch)}>
            <input
              value={skillQuery}
              onChange={(event) => setSkillQuery(event.target.value)}
              placeholder={t("Search skills")}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontSize: 11,
                outline: "none",
                padding: "6px 8px",
                width: "100%",
              }}
            />
          </div>
          <div {...stylex.props(inlineStyles.inline46)}>
            {loading ? (
              <div {...stylex.props(inlineStyles.inline47)}>{t("Loading…")}</div>
            ) : error ? (
              <div {...stylex.props(inlineStyles.inline48)}>{error}</div>
            ) : visibleSkills.length === 0 ? (
              <div {...stylex.props(inlineStyles.inline49)}>{t("No skills found")}</div>
            ) : (
              (() => {
                const groups: {
                  label: string
                  skills: typeof skills
                }[] = []
                for (const grpLabel of ["project", "global", "path"]) {
                  const grpSkills = visibleSkills.filter((s) => sourceLabel(s) === grpLabel)
                  if (grpSkills.length > 0)
                    groups.push({
                      label: grpLabel,
                      skills: grpSkills,
                    })
                }
                return groups.map(({ label: grpLabel, skills: grpSkills }) => (
                  <div key={grpLabel} {...stylex.props(inlineStyles.inline50)}>
                    <div {...stylex.props(inlineStyles.inline51)}>{t(grpLabel)}</div>
                    {grpSkills.map((skill) => {
                      const isSelected = !addMode && selected === skill.filePath
                      const disabled = skill.disableModelInvocation
                      return (
                        <div
                          key={skill.filePath}
                          onClick={() => {
                            setSelected(skill.filePath)
                            setAddMode(false)
                          }}
                          {...stylex.props(inlineStyles.inline52)}
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
                            {...stylex.props(inlineStyles.inline53)}
                            style={{
                              background: disabled ? "var(--border)" : "var(--accent)",
                              boxShadow: disabled ? "none" : "0 0 4px var(--accent)",
                            }}
                          />
                          <span
                            {...stylex.props(inlineStyles.inline54)}
                            style={{
                              fontWeight: isSelected ? 600 : 400,
                              color: disabled ? "var(--text-dim)" : "var(--text)",
                            }}
                          >
                            {skill.name}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))
              })()
            )}
          </div>
          {/* Add skill button */}
          <div {...stylex.props(inlineStyles.inline55)}>
            <div
              onClick={() => setAddMode(true)}
              {...stylex.props(inlineStyles.inline56)}
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
              {t("Add skill")}
            </div>
          </div>
        </div>

        {/* Right: detail or add panel */}
        <div {...stylex.props(inlineStyles.inline57)}>
          {addMode ? (
            <AddSkillPanel
              cwd={cwd}
              onInstalled={() => {
                loadSkills()
              }}
            />
          ) : loading ? null : selectedSkill ? (
            <SkillDetail
              key={selectedSkill.filePath}
              skill={selectedSkill}
              cwd={cwd}
              onToggle={toggle}
              toggling={toggling.has(selectedSkill.filePath)}
              saveError={saveError}
              onDelete={deleteSkill}
              deleting={deleting === selectedSkill.filePath}
            />
          ) : (
            <div {...stylex.props(inlineStyles.inline58)}>{t("Select a skill")}</div>
          )}
        </div>
      </div>

      <div {...stylex.props(inlineStyles.inline59)}>
        <button onClick={onClose} {...stylex.props(inlineStyles.inline60)}>
          {t("Close")}
        </button>
      </div>
    </SettingsWorkspace>
  )
}
const inlineStyles = stylex.create({
  deleteSkill: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(239,68,68,.08)",
    border: "1px solid rgba(239,68,68,.24)",
    borderRadius: 6,
    color: "#ef4444",
    cursor: "pointer",
    fontSize: 11,
    paddingBlock: 6,
    paddingInline: 10,
  },
  skillSearch: { borderBottom: "1px solid var(--border)", padding: 8 },
  skillSummary: {
    alignItems: "baseline",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
    padding: 10,
  },
  skillFilters: { display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 8px 0" },
  skillFinder: { display: "grid", height: "100%", minHeight: 0, overflow: "hidden" },
  skillFileTree: {
    backgroundColor: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    minHeight: 0,
    overflow: "auto",
    paddingBlock: 8,
  },
  skillPaneTitle: { color: "var(--text-dim)", fontSize: 10, fontWeight: 700, padding: "6px 9px" },
  skillFileRow: {
    alignItems: "center",
    border: "none",
    color: "var(--text-muted)",
    display: "flex",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    gap: 5,
    minHeight: 25,
    overflow: "hidden",
    paddingRight: 7,
    textAlign: "left",
    width: "100%",
  },
  skillPreview: { display: "grid", gridTemplateRows: "38px minmax(0, 1fr)", minHeight: 0, minWidth: 0 },
  skillPreviewHeader: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    justifyContent: "space-between",
    minWidth: 0,
    paddingInline: 10,
  },
  skillPreviewBody: { minHeight: 0, overflow: "auto" },
  skillInspector: {
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    minHeight: 0,
    overflow: "auto",
    padding: 12,
  },
  skillDescription: { color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55, margin: 0 },
  skillPath: { color: "var(--text-dim)", fontSize: 10, overflowWrap: "anywhere" },
  skillToggleRow: { alignItems: "center", display: "flex", justifyContent: "space-between" },
  deleteConfirm: { display: "flex", flexDirection: "column", gap: 7, marginTop: "auto" },
  inline3: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  inline4: {
    display: "flex",
    alignItems: "center",
    gap: 7,
  },
  inline5: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 3,
    flexShrink: 0,
  },
  inline6: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-dim)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline7: {
    fontSize: 12,
    color: "#f87171",
    flexShrink: 0,
  },
  inline8: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  inline9: {
    fontSize: 12,
    color: "var(--text-muted)",
    fontWeight: 500,
  },
  inline10: {
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    color: "var(--text)",
  },
  inline11: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  inline12: {
    fontSize: 12,
    color: "var(--text-muted)",
    fontWeight: 500,
  },
  inline13: {
    fontSize: 14,
    color: "var(--text-muted)",
    lineHeight: 1.6,
  },
  inline14: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  inline15: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 20,
  },
  inline16: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
  },
  inline17: {
    display: "flex",
    gap: 8,
  },
  inline18: {
    flex: 1,
    padding: "7px 10px",
    fontSize: 13,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    outline: "none",
  },
  inline19: {
    padding: "7px 16px",
    fontSize: 13,
    borderRadius: 6,
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    flexShrink: 0,
  },
  inline20: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  inline21: {
    display: "flex",
    borderRadius: 5,
    border: "1px solid var(--border)",
    overflow: "hidden",
    fontSize: 12,
    flexShrink: 0,
  },
  inline22: {
    padding: "3px 10px",
    border: "none",
    cursor: "pointer",
  },
  inline23: {
    fontSize: 12,
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline24: {
    fontSize: 12,
    color: "#f87171",
  },
  inline25: {
    fontSize: 12,
    color: "#f87171",
    wordBreak: "break-word",
  },
  inline26: {
    flex: 1,
    overflowY: "auto",
  },
  inline27: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "12px 0",
    borderBottom: "1px solid var(--border)",
  },
  inline28: {
    flex: 1,
    minWidth: 0,
  },
  inline29: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 3,
  },
  inline30: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  inline31: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline32: {
    fontSize: 12,
    color: "var(--text-muted)",
    fontWeight: 500,
  },
  inline33: {
    fontSize: 12,
    color: "var(--accent)",
    textDecoration: "none",
  },
  inline34: {
    flexShrink: 0,
    padding: "5px 14px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 5,
    border: "1px solid var(--border)",
    transition: "color 0.12s",
  },
  inline35: {
    fontSize: 13,
    color: "var(--text-dim)",
    lineHeight: 1.8,
  },
  inline36: {
    color: "var(--accent)",
    textDecoration: "none",
  },
  inline42: {
    fontSize: 11,
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    maxWidth: 320,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline44: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
  },
  inline45: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    background: "var(--bg-panel)",
  },
  inline46: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 6px",
  },
  inline47: {
    padding: "10px 8px",
    fontSize: 12,
    color: "var(--text-muted)",
  },
  inline48: {
    padding: "10px 8px",
    fontSize: 11,
    color: "#f87171",
  },
  inline49: {
    padding: "10px 8px",
    fontSize: 11,
    color: "var(--text-dim)",
  },
  inline50: {
    marginBottom: 6,
  },
  inline51: {
    padding: "4px 8px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  inline52: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 8px",
    borderRadius: 5,
    cursor: "pointer",
  },
  inline53: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: "50%",
    transition: "background 0.15s, box-shadow 0.15s",
  },
  inline54: {
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  inline55: {
    padding: "8px 6px",
    borderTop: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline56: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 8px",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
  },
  inline57: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  inline58: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-dim)",
    fontSize: 13,
  },
  inline59: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "10px 18px",
    borderTop: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline60: {
    padding: "6px 14px",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 13,
  },
})
