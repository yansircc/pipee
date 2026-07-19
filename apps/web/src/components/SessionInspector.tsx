import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import type { SessionStats, WeixinStatusProjection } from "@/api/contract"
import { runBrowser, type Cancel } from "@/browser/api-client"
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

type SessionCopyField = "file" | "id"

type SessionInspectorProps = {
  readonly contextUsage: SessionContextUsage | null
  readonly cwd: string | null
  readonly selectedSessionId: string | null
  readonly sessionStats: SessionStats | null
  readonly systemPromptState: SystemPromptState
  readonly weixinStatus: WeixinStatusProjection | undefined
}

const formatCompact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(0)}k`
      : String(value)

export function SessionInspector({
  contextUsage,
  cwd,
  selectedSessionId,
  sessionStats,
  systemPromptState,
  weixinStatus,
}: SessionInspectorProps) {
  const { t } = useI18n()
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null)
  const sessionCopyTimerRef = useRef<Cancel | null>(null)
  const displayedContext = contextUsage ?? sessionStats?.contextUsage ?? null

  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    sessionCopyTimerRef.current?.()
    sessionCopyTimerRef.current = runBrowser(
      copyText(value).pipe(
        Effect.tap(() => Effect.sync(() => setCopiedSessionField(field))),
        Effect.andThen(Effect.sleep("1400 millis")),
        Effect.tap(() => Effect.sync(() => setCopiedSessionField(null))),
      ),
      { onSuccess: () => undefined },
    )
  }, [])

  useEffect(
    () => () => {
      sessionCopyTimerRef.current?.()
    },
    [],
  )

  const section = (
    title: string,
    sectionRows: ReadonlyArray<readonly [string, string]>,
    valueAlign: "left" | "right" = "left",
    compact = false,
  ) => (
    <div {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionTitle)}>{title}</div>
      <div
        {...stylex.props(styles.rows)}
        style={{
          columnGap: compact ? 14 : 12,
          gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
          justifyContent: compact ? "start" : undefined,
        }}
      >
        {sectionRows.map(([label, value]) => (
          <div key={`${title}:${label}`} {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.label)}>{label}</div>
            <div
              {...stylex.props(styles.value)}
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
        aria-label={copied ? t("Copied") : t(field === "file" ? "Copy file path" : "Copy session ID")}
        onClick={() => handleCopySessionField(field, value)}
        {...stylex.props(styles.copyField, copied && styles.copyFieldCopied)}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    )
  }

  return (
    <div className={`${stylex.props(styles.panel).className} session-info-popover`}>
      <button
        type="button"
        {...stylex.props(styles.copyDebug)}
        onClick={() =>
          runBrowser(
            copyText(
              JSON.stringify(
                {
                  context: contextUsage,
                  cwd,
                  session: sessionStats,
                  systemPrompt: systemPromptState,
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
        {t("Copy debug information")}
      </button>

      <section {...stylex.props(styles.systemPrompt)}>
        <div {...stylex.props(styles.systemPromptHeader)}>
          <strong>{t("System prompt")}</strong>
          {systemPromptState.status === "ready" && systemPromptState.sessionId === selectedSessionId && (
            <button
              type="button"
              onClick={() => runBrowser(copyText(systemPromptState.prompt), { onSuccess: () => undefined })}
            >
              {t("Copy")}
            </button>
          )}
        </div>
        {selectedSessionId === null || systemPromptState.status === "none" ? (
          <span>{t("No session selected")}</span>
        ) : systemPromptState.sessionId !== selectedSessionId || systemPromptState.status === "loading" ? (
          <span>{t("Loading…")}</span>
        ) : systemPromptState.status === "error" ? (
          <span {...stylex.props(styles.systemPromptError)}>{systemPromptState.error}</span>
        ) : (
          <pre {...stylex.props(styles.systemPromptPreview)}>{systemPromptState.prompt}</pre>
        )}
      </section>

      {sessionStats ? (
        <div {...stylex.props(styles.stats)}>
          <div {...stylex.props(styles.section)}>
            <div {...stylex.props(styles.sectionTitle)}>{t("Session Info")}</div>
            <div {...stylex.props(styles.sessionRows)}>
              {[
                ...(sessionStats.sessionName
                  ? [{ copyField: null, label: "Name", value: sessionStats.sessionName }]
                  : []),
                { copyField: "file" as const, label: "File", value: sessionStats.sessionFile ?? "In-memory" },
                { copyField: "id" as const, label: "ID", value: sessionStats.sessionId },
              ].map((row) => (
                <div key={row.label} {...stylex.props(styles.row)}>
                  <div {...stylex.props(styles.label)}>{row.label}</div>
                  <div {...stylex.props(styles.sessionValue)}>{row.value}</div>
                  <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                </div>
              ))}
            </div>
          </div>
          {section(t("Messages"), [
            [t("User"), sessionStats.userMessages.toLocaleString()],
            [t("Assistant"), sessionStats.assistantMessages.toLocaleString()],
            [t("Tool Calls"), sessionStats.toolCalls.toLocaleString()],
            [t("Tool Results"), sessionStats.toolResults.toLocaleString()],
            [t("Total"), sessionStats.totalMessages.toLocaleString()],
          ])}
          {section(
            t("Tokens"),
            [
              [t("Input"), sessionStats.tokens.input.toLocaleString()],
              [t("Output"), sessionStats.tokens.output.toLocaleString()],
              ...(sessionStats.tokens.cacheRead > 0
                ? ([[t("Cache Read"), sessionStats.tokens.cacheRead.toLocaleString()]] as const)
                : []),
              ...(sessionStats.tokens.cacheWrite > 0
                ? ([[t("Cache Write"), sessionStats.tokens.cacheWrite.toLocaleString()]] as const)
                : []),
              [t("Total"), sessionStats.tokens.total.toLocaleString()],
              ...(sessionStats.cost > 0 ? ([["Cost", `$${sessionStats.cost.toFixed(4)}`]] as const) : []),
              ...(displayedContext?.contextWindow
                ? ([
                    [
                      "Context",
                      `${displayedContext.percent !== null ? `${displayedContext.percent.toFixed(1)}%` : "?"} / ${formatCompact(displayedContext.contextWindow)}`,
                    ],
                  ] as const)
                : []),
            ],
            "right",
            true,
          )}
        </div>
      ) : (
        <div {...stylex.props(styles.empty)}>{t("Send a message or run /session to load session info")}</div>
      )}
    </div>
  )
}

const styles = stylex.create({
  panel: { backgroundColor: "var(--bg-raised)", padding: 12 },
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
  systemPrompt: {
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 14,
    paddingBottom: 14,
  },
  systemPromptHeader: { alignItems: "center", display: "flex", justifyContent: "space-between" },
  systemPromptPreview: {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    lineHeight: 1.5,
    margin: 0,
    maxHeight: 220,
    overflow: "auto",
    overflowWrap: "anywhere",
    padding: 10,
    whiteSpace: "pre-wrap",
  },
  systemPromptError: { color: "#ef4444" },
  stats: { display: "grid", fontFamily: "var(--font-mono)", fontSize: 12, gap: 16, lineHeight: 1.5 },
  section: { minWidth: 0 },
  sectionTitle: { color: "var(--text)", fontSize: 11, fontWeight: 700, marginBottom: 6 },
  rows: { display: "grid", rowGap: 4 },
  sessionRows: {
    alignItems: "start",
    columnGap: 12,
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    rowGap: 8,
  },
  row: { display: "contents" },
  label: { color: "var(--text-dim)", whiteSpace: "nowrap" },
  value: { color: "var(--text-muted)", minWidth: 0 },
  sessionValue: {
    color: "var(--text-muted)",
    minWidth: 0,
    overflowWrap: "anywhere",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  copyField: {
    alignItems: "center",
    alignSelf: "start",
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-dim)",
    cursor: "pointer",
    display: "inline-flex",
    flex: "0 0 auto",
    height: 22,
    justifyContent: "center",
    marginTop: -2,
    transition: "color 0.12s, border-color 0.12s, background 0.12s",
    width: 22,
    ":hover": { backgroundColor: "var(--bg-hover)", borderColor: "var(--accent)", color: "var(--accent)" },
  },
  copyFieldCopied: { color: "var(--accent)" },
  empty: { color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" },
})
