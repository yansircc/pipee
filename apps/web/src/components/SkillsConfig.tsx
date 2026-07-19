import * as stylex from "@stylexjs/stylex"
import { useState, useEffect, useCallback, useRef } from "react"
import { useIsMobile } from "@/hooks/useIsMobile"
import type { SkillSearchResult } from "@/api/contract"
import { useI18n } from "@/lib/i18n"
import { withApi, runApi } from "@/browser/api-client"
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
function Toggle({ enabled, loading, onToggle }: { enabled: boolean; loading: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      title={
        enabled ? t("Visible in model prompt — click to disable") : t("Hidden from model prompt — click to enable")
      }
      {...stylex.props(inlineStyles.inline1)}
      style={{
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
      }}
    >
      <span
        {...stylex.props(inlineStyles.inline2)}
        style={{
          left: enabled ? 21 : 3,
        }}
      />
    </button>
  )
}
function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
}: {
  skill: Skill
  cwd: string
  onToggle: (skill: Skill) => void
  toggling: boolean
  saveError: string | null
}) {
  const label = sourceLabel(skill)
  const enabled = !skill.disableModelInvocation
  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "")
      return `./${rel}`
    }
    return shortenPath(p)
  }
  return (
    <div {...stylex.props(inlineStyles.inline3)}>
      {/* Path + tag + toggle */}
      <div {...stylex.props(inlineStyles.inline4)}>
        <span
          {...stylex.props(inlineStyles.inline5)}
          style={{
            background: label === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
            color: label === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
          }}
        >
          {label}
        </span>
        <span {...stylex.props(inlineStyles.inline6)}>{displayPath(skill.filePath)}</span>
        <Toggle enabled={enabled} loading={toggling} onToggle={() => onToggle(skill)} />
        {saveError && <span {...stylex.props(inlineStyles.inline7)}>{saveError}</span>}
      </div>

      <div {...stylex.props(inlineStyles.inline8)}>
        <span {...stylex.props(inlineStyles.inline9)}>Name</span>
        <span {...stylex.props(inlineStyles.inline10)}>{skill.name}</span>
      </div>

      <div {...stylex.props(inlineStyles.inline11)}>
        <span {...stylex.props(inlineStyles.inline12)}>Description</span>
        <span {...stylex.props(inlineStyles.inline13)}>{skill.description}</span>
      </div>
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
  const [addMode, setAddMode] = useState(false)
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
  return (
    <div
      {...stylex.props(inlineStyles.inline37)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        {...stylex.props(inlineStyles.inline38)}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
        }}
      >
        {/* Header */}
        <div {...stylex.props(inlineStyles.inline39)}>
          <div {...stylex.props(inlineStyles.inline40)}>
            <span {...stylex.props(inlineStyles.inline41)}>{t("Skills")}</span>
            <code {...stylex.props(inlineStyles.inline42)}>{shortenPath(cwd)}</code>
          </div>
          <button onClick={onClose} {...stylex.props(inlineStyles.inline43)}>
            ×
          </button>
        </div>

        {/* Body */}
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
              width: isMobile ? "100%" : 210,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
            }}
          >
            <div {...stylex.props(inlineStyles.inline46)}>
              {loading ? (
                <div {...stylex.props(inlineStyles.inline47)}>{t("Loading…")}</div>
              ) : error ? (
                <div {...stylex.props(inlineStyles.inline48)}>{error}</div>
              ) : skills.length === 0 ? (
                <div {...stylex.props(inlineStyles.inline49)}>{t("No skills found")}</div>
              ) : (
                (() => {
                  const groups: {
                    label: string
                    skills: typeof skills
                  }[] = []
                  for (const grpLabel of ["project", "global", "path"]) {
                    const grpSkills = skills.filter((s) => sourceLabel(s) === grpLabel)
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
              />
            ) : (
              <div {...stylex.props(inlineStyles.inline58)}>{t("Select a skill")}</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div {...stylex.props(inlineStyles.inline59)}>
          <button onClick={onClose} {...stylex.props(inlineStyles.inline60)}>
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  )
}
const inlineStyles = stylex.create({
  inline1: {
    flexShrink: 0,
    width: 40,
    height: 22,
    borderRadius: 11,
    border: "none",
    padding: 0,
    position: "relative",
    transition: "background 0.18s",
    outline: "none",
  },
  inline2: {
    position: "absolute",
    top: 3,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "var(--bg)",
    boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
    transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
  },
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
  inline37: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  inline38: {
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "calc(100dvh - 16px)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    overflow: "hidden",
  },
  inline39: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 18px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  inline40: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
  },
  inline41: {
    fontSize: 15,
    fontWeight: 700,
    color: "var(--text)",
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
  inline43: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 20,
    lineHeight: 1,
    padding: "2px 6px",
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
    overflowY: "auto",
    padding: 20,
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
