import { useEffect, useMemo, useState } from "react"
import { runBrowser } from "@/browser/api-client"
import { observeCurrentTime } from "@/browser/timing"
import type { LoopControlAction, LoopProjection, LoopStatusProjection } from "@/features/session/session-automation"
import { useI18n } from "@/lib/i18n"

interface Props {
  status: LoopStatusProjection
  pending: boolean
  sessionBusy: boolean
  onControl: (action: LoopControlAction) => void
}

type IntervalUnit = "s" | "m" | "h" | "d"
const unitMs: Readonly<Record<IntervalUnit, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export const intervalParts = (milliseconds: number): { amount: number; unit: IntervalUnit } => {
  for (const unit of ["d", "h", "m", "s"] as const) {
    if (milliseconds % unitMs[unit] === 0) return { amount: milliseconds / unitMs[unit], unit }
  }
  return { amount: Math.max(1, Math.round(milliseconds / 1_000)), unit: "s" }
}

export const countdownText = (dueAt: number | undefined, now: number, zh: boolean): string => {
  if (dueAt === undefined) return zh ? "等待安排" : "Awaiting schedule"
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
    case "Interval": {
      const value = intervalParts(loop.schedule.periodMs)
      return `${value.amount}${value.unit}`
    }
    case "Dynamic":
      return "dynamic"
    case "Cron":
      return `${loop.schedule.expression} · ${loop.schedule.timeZone}`
    case "Once":
      return "once"
  }
}

export function SessionAutomationBar({ status, pending, sessionBusy, onControl }: Props) {
  const { locale } = useI18n()
  const zh = locale === "zh-CN"
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [amount, setAmount] = useState("30")
  const [unit, setUnit] = useState<IntervalUnit>("m")
  const [now, setNow] = useState(status.observedAt)

  useEffect(
    () =>
      runBrowser(observeCurrentTime("1 second", setNow), {
        onSuccess: () => undefined,
      }),
    [],
  )

  useEffect(() => {
    if (editingId !== null && !status.loops.some((loop) => loop.id === editingId)) setEditingId(null)
  }, [editingId, status.loops])

  const nearestDueAt = useMemo(() => {
    const due = status.loops
      .filter((loop) => loop.enabled)
      .flatMap((loop) => {
        const value = dueAt(loop)
        return value === undefined ? [] : [value]
      })
    return due.length === 0 ? undefined : Math.min(...due)
  }, [status.loops])

  const edit = (loop: LoopProjection) => {
    if (loop.schedule._tag !== "Interval") return
    const value = intervalParts(loop.schedule.periodMs)
    setEditingId(loop.id)
    setPrompt(loop.prompt)
    setAmount(String(value.amount))
    setUnit(value.unit)
    setOpen(true)
  }

  const resetEditor = () => {
    setEditingId(null)
    setPrompt("")
    setAmount("30")
    setUnit("m")
  }

  const numericAmount = Number(amount)
  const periodMs = numericAmount * unitMs[unit]
  const canSave = prompt.trim().length > 0 && Number.isSafeInteger(periodMs) && numericAmount >= 1 && !pending

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-panel)]">
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <span aria-hidden="true" className="text-[var(--accent)]">
          ◷
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-w-0 flex-1 text-left">
          <span className="block text-xs font-semibold text-[var(--text)]">
            {zh ? "会话自动化" : "Session automations"} · {status.loops.length}
          </span>
          <span className="block truncate text-[11px] text-[var(--text-muted)]">
            {status.loops.length === 0
              ? zh
                ? "当前会话没有自动化"
                : "No automations for this session"
              : nearestDueAt === undefined
                ? zh
                  ? "没有待执行任务"
                  : "No scheduled runs"
                : `${zh ? "最近执行" : "Next run"} · ${countdownText(nearestDueAt, now, zh)}`}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            resetEditor()
            setOpen(true)
          }}
          className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
        >
          {zh ? "新建" : "New"}
        </button>
      </div>

      {open && (
        <div className="border-t border-[var(--border)] p-3">
          <div className="space-y-2">
            {status.loops.map((loop) => (
              <div key={loop.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[var(--text)]">{loop.label ?? loop.prompt}</div>
                    <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                      {scheduleText(loop)} ·{" "}
                      {loop.retention === "project" ? (zh ? "项目" : "project") : zh ? "会话" : "session"} ·{" "}
                      {loop.phase._tag === "Paused"
                        ? zh
                          ? "已暂停"
                          : "paused"
                        : loop.phase._tag === "AwaitingAgent"
                          ? zh
                            ? "等待 Agent 安排"
                            : "awaiting agent"
                          : countdownText(loop.phase.dueAt, now, zh)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={pending || sessionBusy || !loop.enabled}
                    onClick={() => onControl({ _tag: "RunNow", id: loop.id })}
                    className="rounded border border-[var(--border)] px-2 py-1 text-[10px] disabled:opacity-40"
                  >
                    {zh ? "立即执行" : "Run"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onControl({ _tag: "SetEnabled", id: loop.id, enabled: !loop.enabled })}
                    className="rounded border border-[var(--border)] px-2 py-1 text-[10px] disabled:opacity-40"
                  >
                    {loop.enabled ? (zh ? "暂停" : "Pause") : zh ? "恢复" : "Resume"}
                  </button>
                  {loop.schedule._tag === "Interval" && (
                    <button type="button" disabled={pending} onClick={() => edit(loop)} className="px-1 text-[10px]">
                      {zh ? "编辑" : "Edit"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onControl({ _tag: "Delete", id: loop.id })}
                    className="px-1 text-[10px] text-red-500 disabled:opacity-40"
                  >
                    {zh ? "删除" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <label className="block text-[11px] text-[var(--text-muted)]">
              {zh ? "自动发送的消息" : "Scheduled message"}
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                className="mt-1.5 block w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs text-[var(--text)]"
              />
            </label>
            <div className="mt-2 flex items-end gap-2">
              <label className="flex-1 text-[11px] text-[var(--text-muted)]">
                {zh ? "执行间隔" : "Interval"}
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs"
                />
              </label>
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value as IntervalUnit)}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs"
              >
                <option value="s">s</option>
                <option value="m">m</option>
                <option value="h">h</option>
                <option value="d">d</option>
              </select>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => {
                  if (!canSave) return
                  onControl(
                    editingId === null
                      ? { _tag: "CreateInterval", periodMs, prompt: prompt.trim() }
                      : { _tag: "UpdateInterval", id: editingId, periodMs, prompt: prompt.trim() },
                  )
                  resetEditor()
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs text-white disabled:opacity-40"
              >
                {editingId === null ? (zh ? "创建" : "Create") : zh ? "保存" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
