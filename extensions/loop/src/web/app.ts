import { connectWebSurfaceBrowser } from "@pipee/companion-contracts/web-surface-browser";
import type { JsonValue, WebSurfaceSessionContext } from "@pipee/companion-contracts/web-surface";
import {
  aggregateOwnedLoops,
  type LoopWebProjection as View,
  type LoopWebProjectionItem as Loop,
  type OwnedLoop,
} from "./model.js";

const root = document.querySelector<HTMLDivElement>("#app")!;
const knownSessions = new Map<string, WebSurfaceSessionContext>();
const views = new Map<string, { session: WebSurfaceSessionContext; view: View }>();
let entries = new Map<string, OwnedLoop>();
let editing: OwnedLoop | null = null;

const esc = (value: string | number | null | undefined) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const asView = (value: JsonValue | null): View | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as View) : null;
const date = (value?: number) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(value)
    : "等待 Agent";
const schedule = (loop: Loop) =>
  loop.schedule._tag === "Cron"
    ? loop.schedule.expression
    : loop.schedule._tag === "Interval"
      ? `每 ${Math.round((loop.schedule.periodMs ?? 0) / 60000)} 分钟`
      : loop.schedule._tag === "Dynamic"
        ? "Agent 动态决定"
        : "单次运行";
const sessionName = (session: WebSurfaceSessionContext) => session.name || session.sessionId;
const projectName = (session: WebSurfaceSessionContext) =>
  (session.projectRoot || session.cwd).split("/").filter(Boolean).at(-1) || session.cwd;
const formText = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

function render() {
  const loops = aggregateOwnedLoops([...views.values()]);
  entries = new Map(loops.map((entry) => [entry.key, entry]));
  const active = loops.filter(({ loop }) => loop.enabled);
  const next = active.find(({ loop }) => loop.phase.dueAt !== undefined);
  const dynamic = loops.filter(({ loop }) => loop.schedule._tag === "Dynamic").length;
  const fallbackSession = [...knownSessions.values()].sort((left, right) =>
    right.modified.localeCompare(left.modified),
  )[0];
  root.innerHTML = `<header class="top"><div><h1>Loop 自动化</h1><p>cross-session management surface · @yansircc/pi-loop</p></div><div class="top-actions"><span class="live">● Scheduler active</span><button class="primary" data-action="create" ${fallbackSession ? "" : "disabled"}>＋ 在对话中新建</button></div></header><main class="content"><section class="hero"><div class="next"><div class="clock">◷</div><div><span class="muted">全局下一次唤醒</span><h2>${esc(next?.loop.label ?? next?.loop.prompt ?? "暂无已计划唤醒")}</h2><p class="muted">${date(next?.loop.phase.dueAt)}${next ? ` · ${esc(next.loop.retention)} · ${esc(next.loop.retention === "project" ? projectName(next.session) : sessionName(next.session))}` : ""}</p></div></div><div class="metric"><span>可见 Loops</span><strong>${loops.length}</strong><p class="muted">${active.length} 运行中 · ${loops.length - active.length} 已暂停</p></div><div class="metric"><span>已计划</span><strong>${active.filter(({ loop }) => loop.phase.dueAt).length}</strong><p class="muted">Runtime wakeups</p></div><div class="metric"><span>动态 Loop</span><strong>${dynamic}</strong><p class="muted">由 Agent 决定时间</p></div></section><div class="note">统一聚合当前 Pi 中运行 Runtime 的 Session Loops 与去重后的 Project Loops。每条记录携带真实 owner，操作精确派发到对应 Runtime。</div><div class="section"><div><h3>全部 Loops</h3><p class="muted">Session 是资源归属，不是页面上下文</p></div></div><section class="card">${
    loops.length
      ? loops
          .map(
            ({ key, session, loop }) =>
              `<div class="row" data-key="${esc(key)}"><span class="type">${loop.schedule._tag === "Dynamic" ? "↻" : "◷"}</span><span class="name"><b>${esc(loop.label ?? loop.id)}</b><span class="muted">${esc(loop.prompt)}</span></span><span class="schedule"><b>${esc(schedule(loop))}</b><span class="muted">${esc(loop.schedule.timeZone ?? loop.schedule._tag)}</span></span><span class="owner"><b>${loop.retention === "project" ? `Project · ${esc(projectName(session))}` : "Session"}</b><button data-action="open">${esc(sessionName(session))} ↗</button></span><span class="phase ${loop.enabled ? "" : "paused"}">${loop.enabled ? esc(loop.phase._tag) : "已暂停"}</span><span class="actions"><button class="icon" data-action="run" title="立即运行" aria-label="立即运行" ${loop.enabled ? "" : "disabled"}>▶</button><button class="icon" data-action="toggle" title="${loop.enabled ? "暂停" : "恢复"}" aria-label="${loop.enabled ? "暂停" : "恢复"}">${loop.enabled ? "Ⅱ" : "↻"}</button><button class="icon" data-action="edit" title="编辑" aria-label="编辑">✎</button><button class="icon danger" data-action="delete" title="删除" aria-label="删除">⌫</button></span></div>`,
          )
          .join("")
      : `<div class="empty">当前没有运行中的 Loop Runtime。</div>`
  }</section></main>`;
  if (editing) renderModal();
}

function renderModal() {
  if (!editing) return;
  const loop = editing.loop;
  const kind = loop.schedule._tag.toLowerCase();
  const value =
    kind === "cron"
      ? (loop.schedule.expression ?? "")
      : kind === "interval"
        ? String((loop.schedule.periodMs ?? 60000) / 1000)
        : kind === "once"
          ? "60"
          : "";
  root.insertAdjacentHTML(
    "beforeend",
    `<div class="overlay"><form class="modal" id="edit-form"><h2>编辑 Loop</h2><p class="muted">${esc(loop.retention === "project" ? `Project · ${projectName(editing.session)}` : `Session · ${sessionName(editing.session)}`)}</p><div class="field"><label>名称</label><input name="label" value="${esc(loop.label ?? "")}"></div><div class="field"><label>Prompt</label><textarea name="prompt">${esc(loop.prompt)}</textarea></div><div class="field"><label>完整 Schedule</label><div class="schedule-grid"><select name="kind"><option value="cron" ${kind === "cron" ? "selected" : ""}>Cron</option><option value="interval" ${kind === "interval" ? "selected" : ""}>Interval</option><option value="once" ${kind === "once" ? "selected" : ""}>Once</option><option value="dynamic" ${kind === "dynamic" ? "selected" : ""}>Dynamic</option></select><input name="schedule" value="${esc(value)}" placeholder="cron 表达式或秒数"></div><p class="muted">Retention 不可在此修改；变更所有权需重新创建。</p></div><div class="foot"><button type="button" data-action="cancel">取消</button><button class="primary" type="submit">保存修改</button></div></form></div>`,
  );
}

void connectWebSurfaceBrowser({
  sessions: (sessions) => {
    knownSessions.clear();
    for (const session of sessions) knownSessions.set(session.sessionId, session);
    render();
  },
  projection: (session, value) => {
    const view = asView(value);
    if (view) views.set(session.sessionId, { session, view });
    else views.delete(session.sessionId);
    render();
  },
  sessionClosed: (sessionId) => {
    views.delete(sessionId);
    render();
  },
}).then((client) => {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset["action"];
    if (action === "create") {
      const target = [...knownSessions.values()].sort((left, right) =>
        right.modified.localeCompare(left.modified),
      )[0];
      if (target) client.navigate(`/?session=${encodeURIComponent(target.sessionId)}`);
      return;
    }
    if (action === "cancel") {
      editing = null;
      render();
      return;
    }
    const row = button.closest<HTMLElement>("[data-key]");
    const owned = row?.dataset["key"] ? entries.get(row.dataset["key"]!) : undefined;
    if (!owned) return;
    if (action === "open") {
      client.navigate(`/?session=${encodeURIComponent(owned.session.sessionId)}`);
      return;
    }
    if (action === "edit") {
      editing = owned;
      render();
      return;
    }
    const payload =
      action === "run"
        ? { _tag: "RunNow", id: owned.loop.id }
        : action === "toggle"
          ? { _tag: "SetEnabled", id: owned.loop.id, enabled: !owned.loop.enabled }
          : { _tag: "Delete", id: owned.loop.id };
    const dispatch = () =>
      client.dispatch(owned.session.sessionId, payload).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
      });
    if (action !== "delete") void dispatch();
    else
      void client
        .confirm("删除 Loop", `确定删除「${owned.loop.label ?? owned.loop.id}」？`)
        .then((confirmed) => {
          if (confirmed) void dispatch();
        });
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editing) return;
    const current = editing;
    const data = new FormData(event.target as HTMLFormElement);
    const kind = formText(data, "kind");
    const raw = formText(data, "schedule");
    const schedule =
      kind === "cron"
        ? { kind, expression: raw }
        : kind === "interval"
          ? { kind, periodSeconds: Number(raw), runImmediately: false }
          : kind === "once"
            ? { kind, delaySeconds: Number(raw) }
            : { kind: "dynamic" };
    void client
      .dispatch(current.session.sessionId, {
        _tag: "Update",
        id: current.loop.id,
        label: formText(data, "label") || null,
        prompt: formText(data, "prompt"),
        schedule,
      })
      .then((outcome) => {
        if (outcome._tag === "Accepted") {
          editing = null;
          client.notify("Loop 已更新");
        } else
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
      });
  });
});
