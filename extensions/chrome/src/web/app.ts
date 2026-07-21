import { connectWebSurfaceBrowser } from "@pipee/companion-contracts/web-surface-browser";
import type { JsonValue, WebSurfaceSessionContext } from "@pipee/companion-contracts/web-surface";
import {
  projectCompanionReadiness,
  type ChromeStatusProjection,
  type CompanionReadiness,
} from "@pipee/companion-contracts/chrome";
import type { BrowserCompanionProbe } from "@pipee/companion-contracts/browser-companion";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";

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
  status: ChromeStatusProjection;
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
let browserProbe: BrowserCompanionProbe | null = null;
let currentTime = 0;
let connectionStartedAt = 0;
let returnSessionId: string | null = null;
const webRuntime = ManagedRuntime.make(Layer.empty);

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
    `<div class="overlay"><section class="install-modal"><header><div><h2>安装 Chrome Companion</h2><p>安装页会自动检测并完成安全连接。</p></div><button data-action="close-install" aria-label="关闭">×</button></header><div class="install-steps"><div class="install-step"><b>1</b><div><strong>下载并解压扩展 ZIP</strong><p>ZIP 来自当前 pi-chrome package 的精确 candidate。</p></div><button class="primary" data-action="download">下载 ZIP</button></div><div class="install-step"><b>2</b><div><strong>进入 Chrome 扩展程序页面</strong><p>复制 <code>chrome://extensions</code> 到地址栏，并开启“开发者模式”。</p></div><button data-action="copy-extensions-url">复制地址</button></div><div class="install-step"><b>3</b><div><strong>加载已解压的扩展程序</strong><p>选择刚才解压的目录；回到这里后会自动连接，无需刷新。</p></div></div></div></section></div>`,
  );
}

const readiness = (): CompanionReadiness => {
  const allStatuses = [...views.values()].map(({ view }) => view.status);
  const status =
    allStatuses.find((value) => value.state === "ready") ??
    allStatuses.find((value) => value.bridge === "running") ??
    allStatuses[0] ??
    null;
  return projectCompanionReadiness({
    expected: browserProbe?.expected ?? null,
    probe: browserProbe,
    status,
    startedAt: connectionStartedAt,
    now: currentTime,
  });
};

const readinessText = (value: CompanionReadiness) => {
  switch (value._tag) {
    case "PackageMissing":
      return { label: "Package 不可用", action: "安装 Companion" };
    case "CompanionMissing":
      return { label: "Chrome Companion 未安装", action: "安装 Companion" };
    case "CompanionIncompatible":
      return { label: "Chrome Companion 版本不匹配", action: "重新安装" };
    case "Connecting":
      return { label: "正在建立安全连接…", action: "查看安装说明" };
    case "Ready":
      return {
        label: `Chrome ${value.expected.displayVersion} · 协议匹配 · ${value.connector.label}`,
        action: "查看安装说明",
      };
    case "ConnectionFailed":
      return { label: value.message, action: "重新连接" };
  }
};

function render() {
  const all = activities();
  const allViews = [...views.values()];
  const activeSessionIds = new Set(all.map(({ session }) => session.sessionId));
  const currentReadiness = readiness();
  const companion = readinessText(currentReadiness);
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
  root.innerHTML = `<header class="top"><div><h1>Chrome 自动化</h1><p>browser activity supervision · @yansircc/pi-chrome</p></div><div class="connector-status"><i class="${currentReadiness._tag === "Ready" ? "ok" : ""}"></i><span>${esc(companion.label)}</span><button data-action="${currentReadiness._tag === "ConnectionFailed" ? "reconnect" : "connector"}">${esc(companion.action)}</button>${currentReadiness._tag === "ConnectionFailed" ? '<button data-action="connector">重新下载安装</button>' : ""}${currentReadiness._tag === "Ready" ? '<button class="primary" data-action="return-chat">返回对话并使用 Chrome</button>' : ""}</div></header><main class="content">${currentReadiness._tag === "ConnectionFailed" ? `<div class="note">连接诊断：${esc(currentReadiness.reason)} · ${esc(currentReadiness.message)}</div>` : '<div class="note">Agent 自主操作 Chrome。这里用于观察进度、查看结果和处理明确异常；不会把导航、点击、填写重新做成人工按钮。</div>'}<div class="section"><div><h3>正在进行</h3><p class="muted">按 Session 展示浏览器活动</p></div></div><section class="activity-list">${
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
  browserCompanion: (projection) => {
    if (projection._tag === "Compatible" && browserProbe?._tag !== "Compatible") {
      connectionStartedAt = currentTime;
    }
    browserProbe = projection;
    render();
  },
  sessions: (next, preferredReturnSessionId) => {
    sessions.clear();
    for (const session of next) sessions.set(session.sessionId, session);
    returnSessionId = preferredReturnSessionId ?? null;
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
  webRuntime.runFork(
    Clock.currentTimeMillis.pipe(
      Effect.tap((now) =>
        Effect.sync(() => {
          currentTime = now;
          if (connectionStartedAt === 0) connectionStartedAt = now;
          if (readiness()._tag === "Connecting") render();
        }),
      ),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.asVoid,
    ),
  );
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
      void client.downloadCompanion();
      return;
    }
    if (action === "copy-extensions-url") {
      void client.copyText("chrome://extensions").then((copied) => {
        client.notify(
          copied ? "已复制 chrome://extensions" : "复制失败",
          copied ? "info" : "error",
        );
      });
      return;
    }
    if (action === "reconnect") {
      connectionStartedAt = currentTime;
      void client
        .wakeCompanion()
        .then(() => client.probeCompanion())
        .then(() => render());
      render();
      return;
    }
    if (action === "return-chat") {
      const target =
        (returnSessionId === null ? undefined : sessions.get(returnSessionId)) ??
        [...sessions.values()].sort((left, right) =>
          right.modified.localeCompare(left.modified),
        )[0];
      client.navigate(target ? `/?session=${encodeURIComponent(target.sessionId)}` : "/");
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

globalThis.addEventListener("pagehide", () => void webRuntime.dispose(), { once: true });
