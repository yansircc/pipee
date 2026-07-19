import { connectWebSurfaceBrowser } from "@pi-suite/companion-contracts/web-surface-browser";
import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";
type Tab = { id: number; active: boolean; title: string; url: string };
type Receipt = { at: number; operation: string; tabId?: number; result: string; evidence?: string };
type View = {
  status: {
    state: string;
    bridge: string;
    connector?: { label: string; connected: boolean; lastSeenAt?: number };
    errorMessage?: string;
  };
  tabs: Tab[];
  receipts: Receipt[];
};
const root = document.querySelector<HTMLDivElement>("#app")!;
let view: View | null = null;
let newTab = false;
const esc = (v: string | number | null | undefined) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const asView = (v: JsonValue | null): View | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as unknown as View) : null;
const host = (url: string) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  return anchor.host || url;
};
const time = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function render() {
  if (!view) return;
  const ready = view.status.state === "ready";
  root.innerHTML = `<header class="top"><div><h1>Chrome 自动化</h1><p>session-bound Web Surface · @yansircc/pi-chrome</p></div><div class="top-actions"><button data-action="chat">在对话中执行任务</button><button class="primary" data-action="new" ${ready ? "" : "disabled"}>＋ 新建页面</button></div></header><main class="content"><section class="hero"><div class="connector"><div class="chrome">C</div><div><span class="muted">当前 Chrome Connector</span><h2>${esc(view.status.connector?.label ?? "等待 Chrome extension")}</h2><p class="muted">${esc(view.status.state)} · bridge ${esc(view.status.bridge)}</p></div></div><div class="metric"><span>Session-owned tabs</span><strong>${view.tabs.length}</strong><p class="muted">${view.tabs.filter((t) => t.active).length} 个活动页面</p></div><div class="metric"><span>本次运行</span><strong>${view.receipts.length}</strong><p class="muted">typed operations</p></div><div class="metric"><span>证据产物</span><strong>${view.receipts.filter((r) => r.evidence).length}</strong><p class="muted">snapshot / screenshot</p></div></section><div class="note">这里只管理当前 Session 拥有的 tabs。聚焦、snapshot、截图和关闭直接执行；导航、点击、填写等复杂任务交给 Agent。所有动作绑定精确 tab id。</div><div class="section"><h3>当前页面</h3><p class="muted">没有 active-tab fallback</p></div><div class="layout"><section class="card">${view.tabs.length ? view.tabs.map((tab) => `<div class="tab" data-id="${tab.id}"><span class="favicon">${esc(host(tab.url).slice(0, 2).toUpperCase() || "C")}</span><span class="tab-copy"><b>${esc(tab.title || "Untitled")}</b><span class="muted">${esc(host(tab.url))} · tab ${tab.id}</span></span><span class="state ${tab.active ? "active" : ""}">${tab.active ? "● 当前页面" : "后台页面"}</span><span class="actions"><button class="icon" data-action="activate" title="聚焦">⌗</button><button class="icon" data-action="snapshot" title="Snapshot">◉</button><button class="icon" data-action="screenshot" title="截图">▣</button><button class="icon danger" data-action="close" title="关闭">×</button></span></div>`).join("") : `<div class="empty">当前 Session 尚无页面。</div>`}</section><section class="card health"><h4>Connector 健康</h4><div class="health-row"><i class="dot"></i><div><b>Loopback bridge</b><p class="muted">${esc(view.status.bridge)}</p></div></div><div class="health-row"><i class="dot"></i><div><b>Chrome extension</b><p class="muted">${esc(view.status.connector?.connected ? "connected" : "offline")}</p></div></div><div class="health-row"><i class="dot"></i><div><b>Single flight</b><p class="muted">由 Runtime controller 强制</p></div></div>${view.status.errorMessage ? `<p class="muted">${esc(view.status.errorMessage)}</p>` : ""}</section></div><section class="card log"><h4>最近操作与证据</h4>${view.receipts.length ? view.receipts.map((r) => `<div class="receipt"><time>${time.format(r.at)}</time><span class="op">${esc(r.operation)}</span><span>tab ${esc(r.tabId ?? "—")}</span><span>${esc(r.evidence ?? r.result)}</span></div>`).join("") : `<p class="muted">尚无 Web Surface 操作。</p>`}</section></main>`;
  if (newTab)
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="overlay"><form class="modal" id="new-tab"><h2>新建 Session-owned 页面</h2><input name="url" type="url" value="https://" required placeholder="https://example.com"><p class="muted">创建后归当前 Pi Session 所有。</p><div class="foot"><button type="button" data-action="cancel">取消</button><button class="primary">创建页面</button></div></form></div>`,
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
    if (action === "chat") return client.navigate("/");
    if (action === "new") {
      newTab = true;
      return render();
    }
    if (action === "cancel") {
      newTab = false;
      return render();
    }
    const row = button.closest<HTMLElement>("[data-id]");
    const tabId = Number(row?.dataset["id"]);
    if (!Number.isInteger(tabId)) return;
    const tags = {
      activate: "Activate",
      snapshot: "Snapshot",
      screenshot: "Screenshot",
      close: "Close",
    } as const;
    const dispatch = () =>
      client.dispatch({ _tag: tags[action as keyof typeof tags], tabId }).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
      });
    if (action !== "close") return void dispatch();
    void client.confirm("关闭 Chrome 页面", `确定关闭 tab ${tabId}？`).then((confirmed) => {
      if (confirmed) void dispatch();
    });
  });
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    const value = data.get("url");
    if (typeof value !== "string") return;
    void client.dispatch({ _tag: "NewTab", url: value }).then((outcome) => {
      if (outcome._tag === "Accepted") {
        newTab = false;
        client.notify("页面已创建");
        render();
      } else client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
    });
  });
});
