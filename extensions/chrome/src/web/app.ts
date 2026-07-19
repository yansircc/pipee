import { connectWebSurfaceBrowser } from "@pi-suite/companion-contracts/web-surface-browser";
import type {
  JsonValue,
  WebSurfaceSessionContext,
} from "@pi-suite/companion-contracts/web-surface";

type Tab = { id: number; active: boolean; title: string; url: string };
type Receipt = { at: number; operation: string; tabId?: number; result: string; evidence?: string };
type Activity = { operation: string; startedAt: number };
type ActivityEvent = {
  at: number;
  operation: string;
  phase: "started" | "completed" | "failed";
  message?: string;
};
type View = {
  status: {
    state: string;
    bridge: string;
    connector?: { label: string; connected: boolean; lastSeenAt?: number };
    errorMessage?: string;
  };
  tabs: Tab[];
  receipts: Receipt[];
  activity: Activity | null;
  events: ActivityEvent[];
};
type SessionActivity = { session: WebSurfaceSessionContext; view: View };

const root = document.querySelector<HTMLDivElement>("#app")!;
const sessions = new Map<string, WebSurfaceSessionContext>();
const views = new Map<string, SessionActivity>();
let liveSessionId: string | null = null;
let installOpen = false;

const esc = (value: string | number | null | undefined) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const asView = (value: JsonValue | null): View | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as View) : null;
const sessionName = (session: WebSurfaceSessionContext) => session.name || session.sessionId;
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
const currentTab = (view: View) => view.tabs.find((tab) => tab.active) ?? view.tabs[0];
const activities = () =>
  [...views.values()]
    .filter(({ view }) => view.activity !== null)
    .sort(
      (left, right) =>
        (right.view.receipts[0]?.at ?? 0) - (left.view.receipts[0]?.at ?? 0) ||
        left.session.sessionId.localeCompare(right.session.sessionId),
    );

function renderLive(activity: SessionActivity) {
  const tab = currentTab(activity.view);
  root.insertAdjacentHTML(
    "beforeend",
    `<div class="overlay"><section class="live-modal"><header><div><h2>${esc(sessionName(activity.session))}</h2><p>Chrome 现场直播 · 只读 projection</p></div><button data-action="close-live" aria-label="关闭">×</button></header><div class="live-body"><div class="live-stage"><div class="browser-bar"><span></span><span></span><span></span><b>${esc(tab ? host(tab.url) : "等待页面")}</b></div><div class="browser-page"><strong>${esc(tab?.title ?? "Agent 尚未打开页面")}</strong><p>${esc(tab?.url ?? "")}</p><div class="page-placeholder">真实页面接管仍通过 Chrome Companion 完成</div></div></div><aside class="live-events"><h3>最近事件</h3><div class="event-list">${
      activity.view.events.length
        ? activity.view.events
            .slice(0, 60)
            .map(
              (entry) =>
                `<div class="event"><time>${time.format(entry.at)}</time><div><b>${esc(entry.operation)}</b><p>${esc(entry.phase)}${entry.message ? ` · ${esc(entry.message)}` : ""}</p></div></div>`,
            )
            .join("")
        : `<p class="muted">尚无可投影事件。</p>`
    }</div></aside></div><footer><button data-action="open" data-session="${esc(activity.session.sessionId)}">打开所属对话</button><span>事件列表最多保留 60 条，超出后从最旧事件淘汰。</span></footer></section></div>`,
  );
}

function renderInstall() {
  root.insertAdjacentHTML(
    "beforeend",
    `<div class="overlay"><section class="install-modal"><header><div><h2>安装 Chrome Companion</h2><p>ZIP 可以直接拖入扩展程序页面，无需解压。</p></div><button data-action="close-install" aria-label="关闭">×</button></header><div class="install-steps"><div class="install-step"><b>1</b><div><strong>下载扩展 ZIP</strong><p>下载由当前 pi-chrome package 提供的精确构建产物。</p></div><button class="primary" data-action="download">下载 ZIP</button></div><div class="install-step"><b>2</b><div><strong>打开 Chrome 扩展程序页面</strong><p>在地址栏输入 <code>chrome://extensions</code>，然后开启右上角“开发者模式”。</p></div></div><div class="install-step"><b>3</b><div><strong>把 ZIP 直接拖入页面</strong><p>出现“Chrome Companion 已连接”且兼容性验证通过，即代表安装成功。</p></div></div><details><summary>如果当前 Chrome 或策略拒绝 ZIP</summary><p>仅此时解压 ZIP，再点击“加载已解压的扩展程序”选择该目录。</p></details></div></section></div>`,
  );
}

function render() {
  const all = activities();
  const allViews = [...views.values()];
  const activeSessionIds = new Set(all.map(({ session }) => session.sessionId));
  const connector = allViews.find(({ view }) => view.status.connector?.connected)?.view.status
    .connector;
  const results = allViews
    .flatMap((activity) => {
      const receipt = activity.view.receipts[0];
      return receipt === undefined
        ? []
        : [{ activity, receipt, evidenceCount: activity.view.receipts.length }];
    })
    .sort((left, right) => right.receipt.at - left.receipt.at);
  const tabs = allViews.flatMap((activity) =>
    activeSessionIds.has(activity.session.sessionId)
      ? []
      : activity.view.tabs.map((tab) => ({ activity, tab })),
  );
  root.innerHTML = `<header class="top"><div><h1>Chrome 自动化</h1><p>browser activity supervision · @yansircc/pi-chrome</p></div><div class="connector-status"><i class="${connector ? "ok" : ""}"></i><span>Chrome Companion ${connector ? "已连接" : "未连接"}</span><button data-action="connector">${connector ? "查看安装说明" : "安装 Companion"}</button></div></header><main class="content"><div class="note">Agent 自主操作 Chrome。这里用于观察进度、查看结果和处理明确异常；不会把导航、点击、填写重新做成人工按钮。</div><div class="section"><div><h3>正在进行</h3><p class="muted">按 Session 展示浏览器活动</p></div></div><section class="activity-list">${
    all.length
      ? all
          .map((activity) => {
            const tab = currentTab(activity.view);
            return `<article class="activity-card"><div class="activity-mark">C</div><div class="activity-copy"><span class="running"><i></i>Agent 正在操作</span><h2>${esc(sessionName(activity.session))}</h2><p>${esc(tab?.title ?? "等待 Agent 打开页面")}</p><small>${esc(tab ? host(tab.url) : activity.session.cwd)} · 当前操作：${esc(activity.view.activity?.operation)} · ${activity.view.tabs.length} 个页面</small></div><div class="activity-actions"><button data-action="open" data-session="${esc(activity.session.sessionId)}">打开对话</button><button class="primary" data-action="live" data-session="${esc(activity.session.sessionId)}">现场直播</button><button class="danger" data-action="terminate" data-session="${esc(activity.session.sessionId)}">终止操作</button></div></article>`;
          })
          .join("")
      : `<div class="empty">当前没有进行中的浏览器任务。</div>`
  }</section><div class="section results-heading"><div><h3>最近证据</h3><p class="muted">每个 Session 只展示最新摘要，不展开完整 tool 流水账</p></div></div><section class="card results">${
    results.length
      ? results
          .slice(0, 12)
          .map(
            ({ activity, receipt, evidenceCount }) =>
              `<div class="result-row"><time>${time.format(receipt.at)}</time><div><b>${esc(sessionName(activity.session))}</b><p>最新动作 ${esc(receipt.operation)} · ${evidenceCount} 条近期证据</p></div><span>${esc(receipt.evidence ?? "Receipt")}</span><button data-action="open" data-session="${esc(activity.session.sessionId)}">打开对话</button></div>`,
          )
          .join("")
      : `<div class="empty">尚无浏览器证据。</div>`
  }</section><details class="card idle"><summary>闲置资源 <span>${tabs.length} 个 Session-owned tabs · 默认折叠</span></summary>${
    tabs.length
      ? tabs
          .map(
            ({ activity, tab }) =>
              `<div class="idle-row" data-session="${esc(activity.session.sessionId)}" data-tab="${tab.id}"><div><b>${esc(tab.title || "Untitled")}</b><p>${esc(sessionName(activity.session))} · ${esc(host(tab.url))}</p></div><button data-action="close-tab">关闭</button></div>`,
          )
          .join("")
      : `<div class="empty">没有闲置页面。</div>`
  }</details></main>`;
  const live = liveSessionId ? views.get(liveSessionId) : undefined;
  if (live) renderLive(live);
  if (installOpen) renderInstall();
}

void connectWebSurfaceBrowser({
  sessions: (next) => {
    sessions.clear();
    for (const session of next) sessions.set(session.sessionId, session);
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
    if (liveSessionId === sessionId) liveSessionId = null;
    render();
  },
}).then((client) => {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const action = button.dataset["action"];
    const sessionId =
      button.dataset["session"] ??
      button.closest<HTMLElement>("[data-session]")?.dataset["session"];
    if (action === "connector") {
      installOpen = true;
      render();
      return;
    }
    if (action === "close-install") {
      installOpen = false;
      render();
      return;
    }
    if (action === "download") {
      client.navigate("/api/packages/plugins/pi-chrome/browser-extension.zip");
      return;
    }
    if (action === "open" && sessionId) {
      client.navigate(`/?session=${encodeURIComponent(sessionId)}`);
      return;
    }
    if (action === "live" && sessionId) {
      liveSessionId = sessionId;
      render();
      return;
    }
    if (action === "close-live") {
      liveSessionId = null;
      render();
      return;
    }
    if (action === "terminate" && sessionId) {
      void client
        .confirm("终止 Chrome 操作", "中断 Agent 当前正在执行的 Chrome tool？")
        .then((confirmed) => {
          if (!confirmed) return;
          void client.dispatch(sessionId, { _tag: "Terminate" }).then((outcome) => {
            if (outcome._tag !== "Accepted")
              client.notify(
                outcome._tag === "Rejected" ? outcome.reason : outcome.message,
                "error",
              );
          });
        });
      return;
    }
    if (action !== "close-tab" || !sessionId) return;
    const row = button.closest<HTMLElement>("[data-tab]");
    const tabId = Number(row?.dataset["tab"]);
    if (!Number.isInteger(tabId)) return;
    void client.confirm("关闭 Chrome 页面", `确定关闭 tab ${tabId}？`).then((confirmed) => {
      if (!confirmed) return;
      void client.dispatch(sessionId, { _tag: "Close", tabId }).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
      });
    });
  });
});
