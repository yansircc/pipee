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
import { useAppForm } from "@/ui/interaction/AppForm"
interface Skill {
  name: string
  description: string
  filePath: string
  baseDir: string
  disableModelInvocation: boolean
  mutation:
    | { _tag: "DirectWrite" }
    | { _tag: "ReadOnly"; reason: "package-owned" | "generated-projection" | "filesystem-read-only" | "unavailable" }
  sourceInfo: {
    source?: string
    scope?: string
  }
}
const DESKTOP_WORKSPACE_DIMENSIONS = {
  add: { height: "min(520px, calc(100dvh - 48px))", width: "min(820px, calc(100vw - 32px))" },
  detail: { height: "min(720px, 82vh)", width: "min(960px, 92vw)" },
  library: { height: "min(820px, 92vh)", width: "min(1280px, 96vw)" },
} as const
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
function SkillDetail({ skill, cwd }: { skill: Skill; cwd: string }) {
  const { t } = useI18n()
  const { isDark } = useTheme()
  const isMobile = useIsMobile()
  const [files, setFiles] = useState<Array<{ path: string; name: string; kind: "file" | "directory"; size: number }>>(
    [],
  )
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
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
      style={{ gridTemplateColumns: isMobile ? "135px minmax(0, 1fr)" : "210px minmax(0, 1fr)" }}
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
    </div>
  )
}
function AddSkillPanel({ cwd, onInstalled }: { cwd: string; onInstalled: () => void }) {
  const { t } = useI18n()
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set())
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
    (pkg: string, scope: "global" | "project") => {
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
    [onInstalled, cwd],
  )
  type SubmitMeta = { action: "search"; pkg: null } | { action: "install"; pkg: string }
  const form = useAppForm({
    defaultValues: { query: "", scope: "global" as "global" | "project" },
    onSubmitMeta: { action: "search", pkg: null } as SubmitMeta,
    onSubmit: ({ value, meta }) => {
      if (meta.action === "search") search(value.query)
      else install(meta.pkg, value.scope)
    },
  })
  return (
    <form
      {...stylex.props(inlineStyles.inline14)}
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit({ action: "search", pkg: null })
      }}
    >
      {/* ── Header area ── */}
      <div {...stylex.props(inlineStyles.inline15)}>
        {/* Search row */}
        <div {...stylex.props(inlineStyles.inline17)}>
          <form.Field name="query">
            {(field) => (
              <>
                <input
                  ref={inputRef}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="e.g. react, testing, deploy"
                  {...stylex.props(inlineStyles.inline18)}
                />
                <button
                  type="submit"
                  disabled={searching || !field.state.value.trim()}
                  {...stylex.props(inlineStyles.inline19)}
                  style={{
                    cursor: searching || !field.state.value.trim() ? "not-allowed" : "pointer",
                    opacity: searching || !field.state.value.trim() ? 0.5 : 1,
                  }}
                >
                  {t(searching ? "Searching…" : "Search")}
                </button>
              </>
            )}
          </form.Field>
        </div>

        {/* Scope + install path row */}
        <div {...stylex.props(inlineStyles.inline20)}>
          <form.Field name="scope">
            {(field) => (
              <>
                <div {...stylex.props(inlineStyles.inline21)}>
                  {(["global", "project"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => field.handleChange(scope)}
                      {...stylex.props(inlineStyles.inline22)}
                      style={{
                        background: field.state.value === scope ? "var(--bg-selected)" : "none",
                        color: field.state.value === scope ? "var(--text)" : "var(--text-dim)",
                        fontWeight: field.state.value === scope ? 600 : 400,
                        borderRight: scope === "global" ? "1px solid var(--border)" : "none",
                      }}
                    >
                      {scope}
                    </button>
                  ))}
                </div>
                <span {...stylex.props(inlineStyles.inline23)}>
                  → {field.state.value === "global" ? "~/.pi/agent/skills/" : `${shortenPath(cwd)}/.pi/agent/skills/`}
                </span>
              </>
            )}
          </form.Field>
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
                  type="button"
                  onClick={() =>
                    !isInstalled && !isInstalling && void form.handleSubmit({ action: "install", pkg: r.package })
                  }
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
            <span>
              Search{" "}
              <a href="https://skills.sh" target="_blank" rel="noreferrer" {...stylex.props(inlineStyles.inline36)}>
                skills.sh
              </a>{" "}
              to discover and install skills for your agent.
            </span>
          </div>
        )
      )}
    </form>
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
  const [confirmDelete, setConfirmDelete] = useState(false)
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
          setLoading(false)
        },
        onFailure: (failure) => {
          setError(String(failure))
          setLoading(false)
        },
      },
    )
  }, [cwd])
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
  const enabledCount = skills.filter((skill) => !skill.disableModelInvocation).length
  const libraryMode = !addMode && selectedSkill === null
  const workspaceMode = libraryMode ? "library" : addMode ? "add" : "detail"
  const workspaceDimensions = DESKTOP_WORKSPACE_DIMENSIONS[workspaceMode]
  return (
    <SettingsWorkspace
      actions={
        selectedSkill ? (
          <>
            <span {...stylex.props(inlineStyles.skillSourcePill)}>{t(sourceLabel(selectedSkill))}</span>
            {selectedSkill.mutation._tag === "DirectWrite" ? (
              <span {...stylex.props(inlineStyles.modelInvocationAction)}>
                <span {...stylex.props(inlineStyles.modelInvocationLabel)}>{t("Model invocation")}</span>
                <Toggle
                  enabled={!selectedSkill.disableModelInvocation}
                  label={t(
                    selectedSkill.disableModelInvocation
                      ? "Hidden from model prompt — click to enable"
                      : "Visible in model prompt — click to disable",
                  )}
                  loading={toggling.has(selectedSkill.filePath)}
                  onToggle={() => toggle(selectedSkill)}
                />
              </span>
            ) : (
              <span title={t("Change this skill through its owner")} {...stylex.props(inlineStyles.skillSourcePill)}>
                {t("Read-only")}
              </span>
            )}
            {selectedSkill.mutation._tag === "DirectWrite" && sourceLabel(selectedSkill) !== "path" && (
              <button
                type="button"
                disabled={deleting === selectedSkill.filePath}
                onClick={() => {
                  if (confirmDelete) deleteSkill(selectedSkill)
                  else setConfirmDelete(true)
                }}
                {...stylex.props(inlineStyles.deleteSkill)}
              >
                <span {...stylex.props(inlineStyles.deleteSkillDesktop)}>
                  {confirmDelete ? `${t("Delete")}?` : t("Delete skill")}
                </span>
                <span {...stylex.props(inlineStyles.deleteSkillMobile)}>
                  {confirmDelete ? `${t("Delete")}?` : t("Delete")}
                </span>
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => setAddMode(!addMode)}
            {...stylex.props(addMode ? inlineStyles.libraryAction : inlineStyles.primaryAction)}
          >
            {addMode ? `← ${t("Skills")}` : `＋ ${t("Add skill")}`}
          </button>
        )
      }
      closeLabel={t("Close")}
      leading={
        selectedSkill ? (
          <button
            type="button"
            onClick={() => {
              setSelected(null)
              setConfirmDelete(false)
            }}
            {...stylex.props(inlineStyles.libraryBack)}
          >
            ← <span {...stylex.props(inlineStyles.libraryBackLabel)}>Skill Library</span>
          </button>
        ) : undefined
      }
      context={
        selectedSkill || isMobile ? undefined : (
          <code {...stylex.props(inlineStyles.inline42)}>
            {skills.length} {t("Skills")} · {enabledCount} {t("Enabled")} · {skills.length - enabledCount}{" "}
            {t("Disabled")}
          </code>
        )
      }
      height={isMobile ? "100dvh" : workspaceDimensions.height}
      onClose={onClose}
      title={selectedSkill?.name ?? (addMode ? t("Add skill") : "Skill Library")}
      width={isMobile ? "100vw" : workspaceDimensions.width}
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
            display: libraryMode ? "flex" : "none",
            width: "100%",
            maxHeight: undefined,
            borderRight: "none",
            borderBottom: "none",
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
          <div {...stylex.props(inlineStyles.skillToolbar)}>
            <div {...stylex.props(inlineStyles.skillSearch)}>
              <input
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder={t("Search skills")}
                {...stylex.props(inlineStyles.skillSearchInput)}
              />
            </div>
            <div {...stylex.props(inlineStyles.skillFilters)}>
              {(["all", "project", "global", "path"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={scopeFilter === scope}
                  onClick={() => setScopeFilter(scope)}
                  {...stylex.props(inlineStyles.filterButton)}
                  style={{ background: scopeFilter === scope ? "var(--bg-selected)" : "transparent" }}
                >
                  {t(scope)}
                </button>
              ))}
            </div>
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
                      const disabled = skill.disableModelInvocation
                      return (
                        <button
                          key={skill.filePath}
                          type="button"
                          onClick={() => {
                            setSelected(skill.filePath)
                            setAddMode(false)
                            setConfirmDelete(false)
                          }}
                          {...stylex.props(inlineStyles.skillCard)}
                        >
                          <span {...stylex.props(inlineStyles.skillMonogram)}>
                            {skill.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span {...stylex.props(inlineStyles.skillCardIdentity)}>
                            <strong {...stylex.props(inlineStyles.skillCardTitle)}>{skill.name}</strong>
                            <small {...stylex.props(inlineStyles.skillCardDescription)}>{skill.description}</small>
                          </span>
                          <em {...stylex.props(inlineStyles.skillStatus, disabled && inlineStyles.skillStatusDisabled)}>
                            {t(disabled ? "Disabled" : "Enabled")}
                          </em>
                          <span {...stylex.props(inlineStyles.skillChevron)}>›</span>
                        </button>
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
        <div {...stylex.props(inlineStyles.inline57)} style={{ display: libraryMode ? "none" : "flex" }}>
          {addMode ? (
            <AddSkillPanel
              cwd={cwd}
              onInstalled={() => {
                loadSkills()
              }}
            />
          ) : loading ? null : selectedSkill ? (
            <SkillDetail key={selectedSkill.filePath} skill={selectedSkill} cwd={cwd} />
          ) : (
            <div {...stylex.props(inlineStyles.inline58)}>{t("Select a skill")}</div>
          )}
        </div>
      </div>

      {saveError && <div {...stylex.props(inlineStyles.skillError)}>{saveError}</div>}
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
    paddingInline: { default: 10, "@media (max-width: 760px)": 6 },
    whiteSpace: "nowrap",
  },
  deleteSkillDesktop: { display: { default: "inline", "@media (max-width: 760px)": "none" } },
  deleteSkillMobile: { display: { default: "none", "@media (max-width: 760px)": "inline" } },
  skillToolbar: {
    alignItems: "center",
    borderBottom: "1px solid var(--border-soft)",
    display: "flex",
    gap: 7,
    padding: "9px 14px",
  },
  skillSearch: {
    flex: { default: "1 1 260px", "@media (max-width: 760px)": "1 1 0" },
    minWidth: { default: 160, "@media (max-width: 760px)": 0 },
  },
  skillSearchInput: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text)",
    fontSize: 11,
    height: 32,
    outline: "none",
    paddingInline: 9,
    width: "100%",
  },
  skillSummary: {
    alignItems: "baseline",
    borderBottom: "1px solid var(--border)",
    display: "none",
    flexWrap: "wrap",
    gap: 7,
    padding: 10,
  },
  skillFilters: {
    display: "flex",
    flexShrink: 0,
    gap: 4,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  filterButton: {
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
    fontSize: 11,
    height: 30,
    padding: "0 9px",
    whiteSpace: "nowrap",
  },
  skillFinder: { display: "grid", height: "100%", minHeight: 0, overflow: "hidden" },
  skillFileTree: {
    backgroundColor: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    minHeight: 0,
    overflow: "auto",
    paddingBlock: 10,
  },
  skillPaneTitle: { color: "var(--text-dim)", fontSize: 10, fontWeight: 700, padding: "6px 9px" },
  skillFileRow: {
    alignItems: "center",
    border: "none",
    color: "var(--text-muted)",
    display: "flex",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    gap: 5,
    minHeight: 32,
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
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    margin: "0 auto",
    maxWidth: 800,
    padding: {
      default: "22px 24px 24px",
      "@media (max-width: 760px)": "16px 14px 20px",
    },
    width: "100%",
  },
  inline15: {
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginBottom: 14,
    padding: {
      default: 16,
      "@media (max-width: 760px)": 12,
    },
  },
  inline17: {
    display: "flex",
    gap: 8,
  },
  inline18: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text)",
    flex: 1,
    fontSize: 13,
    height: 38,
    minWidth: 0,
    outline: "none",
    padding: "0 11px",
    ":focus": {
      borderColor: "color-mix(in srgb, var(--accent) 55%, var(--border))",
      boxShadow: "0 0 0 3px var(--accent-soft)",
    },
  },
  inline19: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 7,
    color: "#fff",
    fontSize: 12,
    flexShrink: 0,
    height: 38,
    padding: "0 18px",
  },
  inline20: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
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
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    flex: 1,
    overflowY: "auto",
    padding: "0 14px",
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
    alignItems: "center",
    background: "var(--bg-raised)",
    border: "1px dashed var(--border)",
    borderRadius: 10,
    color: "var(--text-dim)",
    display: "flex",
    flex: 1,
    fontSize: 12,
    justifyContent: "center",
    lineHeight: 1.8,
    minHeight: 124,
    padding: 20,
    textAlign: "center",
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
  libraryBack: {
    background: "var(--bg-hover)",
    border: "none",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    padding: "6px 8px",
    whiteSpace: "nowrap",
  },
  libraryBackLabel: { display: { default: "inline", "@media (max-width: 760px)": "none" } },
  libraryAction: {
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    padding: "7px 10px",
    whiteSpace: "nowrap",
  },
  primaryAction: {
    background: "var(--text)",
    border: "none",
    borderRadius: 7,
    color: "var(--bg-panel)",
    cursor: "pointer",
    fontSize: 12,
    padding: "8px 11px",
  },
  skillSourcePill: {
    background: "var(--success-soft)",
    borderRadius: 7,
    color: "var(--success)",
    fontSize: 11,
    padding: "4px 7px",
    display: { default: "inline", "@media (max-width: 760px)": "none" },
  },
  modelInvocationAction: {
    alignItems: "center",
    border: { default: "1px solid var(--border)", "@media (max-width: 760px)": "none" },
    borderRadius: 7,
    color: "var(--text-muted)",
    display: "flex",
    fontSize: 11,
    gap: 7,
    padding: { default: "3px 7px 3px 9px", "@media (max-width: 760px)": 0 },
  },
  modelInvocationLabel: { display: { default: "inline", "@media (max-width: 760px)": "none" } },
  skillError: {
    background: "rgba(239,68,68,.08)",
    color: "#ef4444",
    fontSize: 11,
    padding: "6px 10px",
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
    padding: "14px 18px 24px",
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
    display: "grid",
    gap: 9,
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      "@media (max-width: 1200px) and (min-width: 761px)": "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 760px)": "1fr",
    },
    marginBottom: 18,
  },
  inline51: {
    gridColumn: "1 / -1",
    padding: "4px",
    fontSize: 11,
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
    display: "none",
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
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  skillCard: {
    alignItems: "center",
    background: "var(--bg-raised)",
    border: "1px solid var(--border-soft)",
    borderRadius: 10,
    color: "var(--text)",
    cursor: "pointer",
    display: "flex",
    gap: 10,
    minHeight: 78,
    padding: 11,
    textAlign: "left",
    ":hover": { background: "var(--bg-hover)", borderColor: "var(--border)" },
  },
  skillMonogram: {
    alignItems: "center",
    background: "var(--success-soft)",
    borderRadius: 10,
    color: "var(--success)",
    display: "flex",
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 800,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  skillCardIdentity: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    gap: 3,
    minWidth: 0,
  },
  skillCardTitle: { color: "var(--text)", fontSize: 13, fontWeight: 650 },
  skillCardDescription: {
    color: "var(--text-dim)",
    display: "-webkit-box",
    fontSize: 11,
    lineHeight: 1.45,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  skillStatus: {
    background: "var(--success-soft)",
    borderRadius: 8,
    color: "var(--success)",
    fontSize: 11,
    fontStyle: "normal",
    padding: "2px 6px",
  },
  skillStatusDisabled: {
    background: "var(--bg-hover)",
    color: "var(--text-dim)",
  },
  skillChevron: { color: "var(--text-dim)" },
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
