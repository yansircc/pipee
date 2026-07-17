import { useEffect, useMemo, useState } from "react"
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
    <section
      className="mb-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-panel)]"
      data-companion-renderer="pi-loop/status@1"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span aria-hidden="true" className="text-[var(--accent)]">
          ◷
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-[var(--text)]">
            {zh ? "会话自动化" : "Session automations"} · {status.loops.length}
          </span>
          <span className="block truncate text-[11px] text-[var(--text-muted)]">
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
        <span className="text-[11px] text-[var(--text-muted)]">{open ? "−" : "+"}</span>
      </button>

      {open && status.loops.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border)] p-3">
          {status.loops.map((loop) => (
            <div key={loop.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5">
              <div className="truncate text-xs font-medium text-[var(--text)]">{loop.label ?? loop.prompt}</div>
              <div className="mt-1 text-[10px] text-[var(--text-muted)]">
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
