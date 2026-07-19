import { connectWebSurfaceBrowser } from "@pi-suite/companion-contracts/web-surface-browser";
import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";
type Loop = {
  id: string;
  prompt: string;
  label?: string;
  enabled: boolean;
  retention: "session" | "project";
  schedule: { _tag: string; periodMs?: number; expression?: string; timeZone?: string };
  phase: { _tag: string; dueAt?: number };
};
type View = { sessionId: string; observedAt: number; loops: Loop[] };
const root = document.querySelector<HTMLDivElement>("#app")!;
let view: View | null = null;
let editing: Loop | null = null;
const esc = (v: string | number | null | undefined) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const date = (v?: number) =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(v)
    : "等待 Agent";
const schedule = (loop: Loop) =>
  loop.schedule._tag === "Cron"
    ? loop.schedule.expression
    : loop.schedule._tag === "Interval"
      ? `每 ${Math.round((loop.schedule.periodMs ?? 0) / 60000)} 分钟`
      : loop.schedule._tag === "Dynamic"
        ? "Agent 动态决定"
        : "单次运行";
const asView = (v: JsonValue | null): View | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as unknown as View) : null;
const formText = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};
function render() {
  if (!view) return;
  const active = view.loops.filter((x) => x.enabled);
  const next = active
    .filter((x) => x.phase.dueAt)
    .sort((a, b) => (a.phase.dueAt ?? 0) - (b.phase.dueAt ?? 0))[0];
  const dynamic = view.loops.filter((x) => x.schedule._tag === "Dynamic").length;
  root.innerHTML = `<header class="top"><div><h1>Loop 自动化</h1><p>session-bound Web Surface · @yansircc/pi-loop</p></div><span class="live">● Scheduler active</span></header><main class="content"><section class="hero"><div class="next"><div class="clock">◷</div><div><span class="muted">下一次唤醒</span><h2>${esc(next?.label ?? next?.prompt ?? "暂无已计划唤醒")}</h2><p class="muted">${date(next?.phase.dueAt)} · ${esc(next?.retention ?? "")}</p></div></div><div class="metric"><span>可见 Loops</span><strong>${view.loops.length}</strong><p class="muted">${active.length} 运行中 · ${view.loops.length - active.length} 已暂停</p></div><div class="metric"><span>已计划</span><strong>${active.filter((x) => x.phase.dueAt).length}</strong><p class="muted">Runtime wakeups</p></div><div class="metric"><span>动态 Loop</span><strong>${dynamic}</strong><p class="muted">由 Agent 决定时间</p></div></section><div class="note">状态来自当前 Session Runtime。立即运行、暂停/恢复、编辑与删除均发送有限 typed action；新建 Loop 仍在对话中完成。</div><div class="section"><div><h3>当前 Loops</h3><p class="muted">按创建顺序投影 · retention 只读</p></div><button class="primary" data-action="create">＋ 在对话中新建</button></div><section class="card">${view.loops.length ? view.loops.map((loop) => `<div class="row" data-id="${esc(loop.id)}"><span class="type">${loop.schedule._tag === "Dynamic" ? "↻" : "◷"}</span><span class="name"><b>${esc(loop.label ?? loop.id)}</b><span class="muted">${esc(loop.prompt)}</span></span><span class="schedule"><b>${esc(schedule(loop))}</b><span class="muted">${esc(loop.retention)} · ${esc(loop.schedule._tag)}</span></span><span class="phase ${loop.enabled ? "" : "paused"}">${loop.enabled ? esc(loop.phase._tag) : "已暂停"}</span><span class="actions"><button class="icon" data-action="run" title="立即运行" ${loop.enabled ? "" : "disabled"}>▶</button><button class="icon" data-action="toggle" title="${loop.enabled ? "暂停" : "恢复"}">${loop.enabled ? "Ⅱ" : "↻"}</button><button class="icon" data-action="edit" title="编辑">✎</button><button class="icon danger" data-action="delete" title="删除">⌫</button></span></div>`).join("") : `<div class="empty">当前 Session 没有 Loop。</div>`}</section></main>`;
  if (editing) renderModal();
}
function renderModal() {
  if (!editing) return;
  const kind = editing.schedule._tag.toLowerCase();
  const value =
    kind === "cron"
      ? (editing.schedule.expression ?? "")
      : kind === "interval"
        ? String((editing.schedule.periodMs ?? 60000) / 1000)
        : kind === "once"
          ? "60"
          : "";
  root.insertAdjacentHTML(
    "beforeend",
    `<div class="overlay"><form class="modal" id="edit-form"><h2>编辑 Loop</h2><div class="field"><label>名称</label><input name="label" value="${esc(editing.label ?? "")}"></div><div class="field"><label>Prompt</label><textarea name="prompt">${esc(editing.prompt)}</textarea></div><div class="field"><label>完整 Schedule</label><div class="schedule-grid"><select name="kind"><option value="cron" ${kind === "cron" ? "selected" : ""}>Cron</option><option value="interval" ${kind === "interval" ? "selected" : ""}>Interval</option><option value="once" ${kind === "once" ? "selected" : ""}>Once</option><option value="dynamic" ${kind === "dynamic" ? "selected" : ""}>Dynamic</option></select><input name="schedule" value="${esc(value)}" placeholder="cron 表达式或秒数"></div><p class="muted">Retention 不可在此修改；变更所有权需重新创建。</p></div><div class="foot"><button type="button" data-action="cancel">取消</button><button class="primary" type="submit">保存修改</button></div></form></div>`,
  );
}
void connectWebSurfaceBrowser({
  projection: (v) => {
    view = asView(v);
    render();
  },
}).then((client) => {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button || !view) return;
    const action = button.dataset["action"];
    if (action === "create")
      return client.navigate(`/?session=${encodeURIComponent(view.sessionId)}`);
    if (action === "cancel") {
      editing = null;
      return render();
    }
    const row = button.closest<HTMLElement>("[data-id]");
    const loop = view.loops.find((x) => x.id === row?.dataset["id"]);
    if (!loop) return;
    if (action === "edit") {
      editing = loop;
      return render();
    }
    const payload =
      action === "run"
        ? { _tag: "RunNow", id: loop.id }
        : action === "toggle"
          ? { _tag: "SetEnabled", id: loop.id, enabled: !loop.enabled }
          : { _tag: "Delete", id: loop.id };
    const dispatch = () =>
      client.dispatch(payload).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
      });
    if (action !== "delete") return void dispatch();
    void client.confirm("删除 Loop", `确定删除「${loop.label ?? loop.id}」？`).then((confirmed) => {
      if (confirmed) void dispatch();
    });
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editing) return;
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
      .dispatch({
        _tag: "Update",
        id: editing.id,
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
