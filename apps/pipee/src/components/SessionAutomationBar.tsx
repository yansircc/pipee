import { useEffect, useMemo, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { runBrowser } from "@/browser/api-client"
import { observeCurrentTime } from "@/browser/timing"
import type { LoopProjection, LoopStatusProjection } from "@/features/session/session-automation"
import { useI18n } from "@/lib/i18n"

interface Props {
  readonly status: LoopStatusProjection
}

export const countdownText = (dueAt: number | undefined, now: number, zh: boolean): string => {
  if (dueAt === undefined) return zh ? "等待 Agent 安排" : "Awaiting agent schedule"
  const seconds = Math.max(0, Math.ceil((dueAt - now) / 1_000))
  if (seconds === 0) return zh ? "等待执行" : "Waiting to run"
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${remainder}s`
}

const dueAt = (loop: LoopProjection): number | undefined =>
  loop.phase._tag === "Scheduled" || loop.phase._tag === "Paused" ? loop.phase.dueAt : undefined

const scheduleText = (loop: LoopProjection): string => {
  switch (loop.schedule._tag) {
    case "Interval":
      return `every ${loop.schedule.periodMs / 1_000}s`
    case "Dynamic":
      return "dynamic"
    case "Cron":
      return `${loop.schedule.expression} · ${loop.schedule.timeZone}`
    case "Once":
      return "once"
  }
}

export function SessionAutomationBar({ status }: Props) {
  const { locale } = useI18n()
  const zh = locale === "zh-CN"
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(status.observedAt)

  useEffect(
    () =>
      runBrowser(observeCurrentTime("1 second", setNow), {
        onSuccess: () => undefined,
      }),
    [],
  )

  const nearestDueAt = useMemo(() => {
    const due = status.loops.flatMap((loop) => {
      const value = loop.enabled ? dueAt(loop) : undefined
      return value === undefined ? [] : [value]
    })
    return due.length === 0 ? undefined : Math.min(...due)
  }, [status.loops])

  return (
    <section {...stylex.props(styles.root)} data-companion-renderer="pi-loop/status@1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        {...stylex.props(styles.trigger)}
      >
        <span aria-hidden="true" {...stylex.props(styles.accent)}>
          ◷
        </span>
        <span {...stylex.props(styles.summary)}>
          <span {...stylex.props(styles.title)}>
            {zh ? "会话自动化" : "Session automations"} · {status.loops.length}
          </span>
          <span {...stylex.props(styles.subtitle)}>
            {status.loops.length === 0
              ? zh
                ? "当前没有自动化"
                : "No automations"
              : nearestDueAt === undefined
                ? zh
                  ? "没有待执行任务"
                  : "No scheduled runs"
                : `${zh ? "最近执行" : "Next run"} · ${countdownText(nearestDueAt, now, zh)}`}
          </span>
        </span>
        <span {...stylex.props(styles.subtitle)}>{open ? "−" : "+"}</span>
      </button>

      {open && status.loops.length > 0 && (
        <div {...stylex.props(styles.list)}>
          {status.loops.map((loop) => (
            <div key={loop.id} {...stylex.props(styles.item)}>
              <div {...stylex.props(styles.itemTitle)}>{loop.label ?? loop.prompt}</div>
              <div {...stylex.props(styles.itemMeta)}>
                {scheduleText(loop)} · {loop.retention} · {loop.id} ·{" "}
                {!loop.enabled
                  ? zh
                    ? "已暂停"
                    : "paused"
                  : loop.phase._tag === "AwaitingAgent"
                    ? zh
                      ? "等待 Agent 安排"
                      : "awaiting agent"
                    : countdownText(dueAt(loop), now, zh)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

const styles = stylex.create({
  root: {
    backgroundColor: "var(--bg-panel)",
    borderColor: "var(--border)",
    borderRadius: 12,
    borderStyle: "solid",
    borderWidth: 1,
    marginBottom: 12,
    overflow: "hidden",
  },
  trigger: {
    alignItems: "center",
    display: "flex",
    gap: 8,
    minHeight: 44,
    paddingBlock: 8,
    paddingInline: 12,
    textAlign: "left",
    width: "100%",
  },
  accent: { color: "var(--accent)" },
  summary: { flex: 1, minWidth: 0 },
  title: { color: "var(--text)", display: "block", fontSize: 12, fontWeight: 600 },
  subtitle: {
    color: "var(--text-muted)",
    display: "block",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  list: {
    borderColor: "var(--border)",
    borderStyle: "solid",
    borderWidth: "1px 0 0",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
  },
  item: {
    backgroundColor: "var(--bg)",
    borderColor: "var(--border)",
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    padding: 10,
  },
  itemTitle: {
    color: "var(--text)",
    fontSize: 12,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  itemMeta: { color: "var(--text-muted)", fontSize: 10, marginTop: 4 },
})
