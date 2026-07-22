import * as stylex from "@stylexjs/stylex"
import type { SessionStats } from "@/api/contract"
import { runBrowser } from "@/browser/api-client"
import { copyText } from "@/lib/clipboard"
import { useI18n } from "@/lib/i18n"

export type SystemPromptState =
  | { readonly status: "none" }
  | { readonly sessionId: string; readonly status: "loading" }
  | { readonly error: string; readonly sessionId: string; readonly status: "error" }
  | { readonly prompt: string; readonly sessionId: string; readonly status: "ready" }

export type SessionContextUsage = {
  readonly contextWindow: number
  readonly percent: number | null
  readonly tokens: number | null
}

type SessionInspectorProps = {
  readonly contextUsage: SessionContextUsage | null
  readonly cwd: string | null
  readonly selectedSessionId: string | null
  readonly sessionStats: SessionStats | null
  readonly systemPromptState: SystemPromptState
}

const formatCompact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(0)}k`
      : String(value)

const compactId = (value: string | null): string => {
  if (value === null) return "—"
  if (value.length <= 16) return value
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

export function SessionInspector({
  contextUsage,
  cwd,
  selectedSessionId,
  sessionStats,
  systemPromptState,
}: SessionInspectorProps) {
  const { t } = useI18n()
  const displayedContext = contextUsage ?? sessionStats?.contextUsage ?? null
  const promptReady = systemPromptState.status === "ready" && systemPromptState.sessionId === selectedSessionId
  const runtimeStatus =
    selectedSessionId === null || systemPromptState.status === "none"
      ? t("No session selected")
      : systemPromptState.sessionId !== selectedSessionId || systemPromptState.status === "loading"
        ? t("Runtime initializing")
        : systemPromptState.status === "error"
          ? t("Runtime failed")
          : t("Runtime ready")
  const contextSummary = displayedContext?.contextWindow
    ? `${displayedContext.percent !== null ? `${displayedContext.percent.toFixed(1)}%` : "?"} / ${formatCompact(displayedContext.contextWindow)}`
    : "—"
  const diagnosticRows = [
    ["Session", compactId(selectedSessionId)],
    [t("Messages"), sessionStats?.totalMessages.toLocaleString() ?? "—"],
    ["CWD", cwd ?? "—"],
    ["Context", contextSummary],
  ] as const

  const copyDebugInformation = () =>
    runBrowser(
      copyText(
        JSON.stringify(
          {
            context: contextUsage,
            cwd,
            session: sessionStats,
            systemPrompt: systemPromptState,
          },
          null,
          2,
        ),
      ),
      { onSuccess: () => undefined },
    )

  return (
    <div className={`${stylex.props(styles.panel).className} session-info-popover`}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <strong {...stylex.props(styles.title)}>Session Inspector</strong>
          <small
            {...stylex.props(
              styles.runtimeStatus,
              systemPromptState.status === "error" && systemPromptState.sessionId === selectedSessionId
                ? styles.runtimeStatusError
                : null,
            )}
          >
            {runtimeStatus}
          </small>
        </div>
        <button type="button" {...stylex.props(styles.secondaryButton)} onClick={copyDebugInformation}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {t("Copy all")}
        </button>
      </header>

      <dl {...stylex.props(styles.summary)}>
        {diagnosticRows.map(([label, value]) => (
          <div key={label} {...stylex.props(styles.summaryCell)}>
            <dt {...stylex.props(styles.summaryLabel)}>{label}</dt>
            <dd title={value} {...stylex.props(styles.summaryValue)}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <section {...stylex.props(styles.systemPrompt)}>
        <div {...stylex.props(styles.systemPromptHeader)}>
          <strong {...stylex.props(styles.systemPromptTitle)}>{t("System prompt")}</strong>
          {promptReady && (
            <button
              type="button"
              {...stylex.props(styles.secondaryButton)}
              onClick={() => runBrowser(copyText(systemPromptState.prompt), { onSuccess: () => undefined })}
            >
              {t("Copy")}
            </button>
          )}
        </div>
        {selectedSessionId === null || systemPromptState.status === "none" ? (
          <span {...stylex.props(styles.promptState)}>{t("No session selected")}</span>
        ) : systemPromptState.sessionId !== selectedSessionId || systemPromptState.status === "loading" ? (
          <span {...stylex.props(styles.promptState)}>{t("Loading…")}</span>
        ) : systemPromptState.status === "error" ? (
          <span {...stylex.props(styles.systemPromptError)}>{systemPromptState.error}</span>
        ) : (
          <pre {...stylex.props(styles.systemPromptPreview)}>{systemPromptState.prompt}</pre>
        )}
      </section>
    </div>
  )
}

const styles = stylex.create({
  panel: { backgroundColor: "var(--bg-raised)", padding: 12 },
  header: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  heading: { display: "flex", flexDirection: "column" },
  title: { fontSize: 13 },
  runtimeStatus: { color: "var(--success)", fontSize: 11 },
  runtimeStatusError: { color: "#ef4444" },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "var(--bg-hover)",
    border: "none",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    fontSize: 11,
    gap: 5,
    paddingBlock: 5,
    paddingInline: 7,
    ":hover": { color: "var(--text)" },
  },
  summary: {
    backgroundColor: "var(--border-soft)",
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    display: "grid",
    gap: 1,
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    margin: "0 0 10px",
    overflow: "hidden",
  },
  summaryCell: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    display: "flex",
    gap: 8,
    justifyContent: "space-between",
    minWidth: 0,
    padding: 7,
  },
  summaryLabel: { color: "var(--text-dim)", flexShrink: 0, fontSize: 11 },
  summaryValue: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    margin: 0,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  systemPrompt: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    padding: 9,
  },
  systemPromptHeader: { alignItems: "center", display: "flex", justifyContent: "space-between" },
  systemPromptTitle: { fontSize: 12 },
  systemPromptPreview: {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    lineHeight: 1.65,
    margin: "8px 0 0",
    maxHeight: 42,
    overflow: "auto",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  promptState: { color: "var(--text-muted)", display: "block", fontSize: 11, marginTop: 8 },
  systemPromptError: { color: "#ef4444", display: "block", fontSize: 11, marginTop: 8 },
})
