import { connectWebSurfaceBrowser } from "@pipee/companion-contracts/web-surface-browser";
import type { JsonValue, WebSurfaceSessionContext } from "@pipee/companion-contracts/web-surface";

type View = {
  sessionId: string;
  cwd: string;
  account: string | null;
  authenticated: boolean;
  enabled: boolean;
  running: boolean;
  sendReady: boolean;
  phase: string;
  defaultSessionId: string | null;
  error: string | null;
  login: { phase: string; qrDataUrl: string | null } | null;
};

const root = document.querySelector<HTMLDivElement>("#app")!;
const sessions = new Map<string, WebSurfaceSessionContext>();
const views = new Map<string, { session: WebSurfaceSessionContext; view: View }>();
let loginDismissed = false;

const esc = (value: string | number | null | undefined) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const asView = (value: JsonValue | null): View | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as View) : null;
const sessionName = (session: WebSurfaceSessionContext) => session.name || session.sessionId;
const owner = () =>
  [...views.values()].sort(
    (left, right) =>
      Number(right.view.login !== null) - Number(left.view.login !== null) ||
      Number(right.view.running) - Number(left.view.running) ||
      Number(right.view.authenticated) - Number(left.view.authenticated) ||
      left.session.sessionId.localeCompare(right.session.sessionId),
  )[0];

const render = () => {
  const current = owner();
  const view = current?.view;
  const connected = view?.phase === "Connected";
  const defaultSession = view?.defaultSessionId ? sessions.get(view.defaultSessionId) : undefined;
  const orderedSessions = [...sessions.values()].sort((left, right) =>
    right.modified.localeCompare(left.modified),
  );
  root.innerHTML = `<div class="shell"><header class="top"><div><h1>微信桥接</h1><p>global account surface · @yansircc/pi-weixin</p></div><span class="live"><i class="dot"></i>${view ? "实时同步中" : "等待 Runtime"}</span></header>
  <main class="content"><section class="hero"><div class="account"><div class="mark">微</div><div><h2>${view?.authenticated ? "微信账号已连接" : "尚未绑定微信"}</h2><div class="muted">${view?.account ? `account · ${esc(view.account)}` : "扫描二维码完成绑定"}</div><div class="state"><i class="dot"></i>${esc(view?.phase ?? "Stopped")}${connected ? " · 长轮询正常" : ""}</div><div class="actions">${view?.authenticated ? `<button data-action="scan">重新扫码</button><button data-action="toggle">${view.enabled ? "暂停桥接" : "恢复桥接"}</button><button class="danger" data-action="logout">解除绑定</button>` : `<button class="primary" data-action="scan" ${current ? "" : "disabled"}>扫码绑定微信</button>`}</div></div></div>
  <div class="metric"><span>登录凭证</span><strong class="${view?.authenticated ? "ok" : ""}">${view?.authenticated ? "有效" : "未绑定"}</strong><p class="muted">${view?.authenticated ? "可重新扫码替换" : "需要微信扫码"}</p></div><div class="metric"><span>主动发送</span><strong class="${view?.sendReady ? "ok" : ""}">${view?.sendReady ? "已就绪" : "未就绪"}</strong><p class="muted">依赖最近消息上下文</p>${view?.sendReady ? '<button data-action="test">发送测试消息</button>' : ""}</div></section>
  <div class="section-title"><h3>消息路由</h3><p>桥接只决定消息进入哪个 Pi Session，不复制聊天界面</p></div><div class="grid"><section class="card"><h4>固定路由规则</h4><div class="route"><div><b>普通微信消息</b><span class="muted">没有引用 Pi 回复</span></div><i class="arrow"></i><div><b>默认 Session</b><span class="muted">${esc(defaultSession ? sessionName(defaultSession) : "尚未设置")}</span></div></div><div class="route"><div><b>引用 Pi 回复</b><span class="muted">携带原消息 identity</span></div><i class="arrow"></i><div><b>原始来源 Session</b><span class="muted">精确回到发出消息的会话</span></div></div><div class="note">无法识别引用来源时 fail closed，不猜测并投递到默认 Session。</div></section><section class="card"><h4>桥接健康</h4><div class="health-row"><i class="dot"></i><div><b>iLink 长轮询</b><p class="muted">${esc(view?.phase ?? "Stopped")}</p></div></div><div class="health-row"><i class="dot"></i><div><b>Pi Gateway</b><p class="muted">${views.size} 个 Runtime projection</p></div></div><div class="health-row"><i class="dot"></i><div><b>账号 ownership</b><p class="muted">单账号跨进程 lease</p></div></div></section></div>
  <div class="section-title"><h3>默认 Session</h3><p>仅接收未引用的微信消息</p></div><section class="card session-list">${
    orderedSessions.length
      ? orderedSessions
          .map(
            (session) =>
              `<div class="session-row" data-session="${esc(session.sessionId)}"><div><b>${esc(sessionName(session))}</b><p class="muted">${esc(session.cwd)}</p></div><div class="session-buttons"><button data-action="open">打开对话 ↗</button><button data-action="default" ${view?.defaultSessionId === session.sessionId || !current ? "disabled" : ""}>${view?.defaultSessionId === session.sessionId ? "当前默认" : "设为默认"}</button></div></div>`,
          )
          .join("")
      : `<div class="loading">当前没有已有 Session。</div>`
  }</section>${view?.error ? `<p class="error">${esc(view.error)}</p>` : ""}</main></div>`;
  if (view?.login && !loginDismissed)
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="overlay"><div class="modal"><div class="modal-title"><h3>${view.authenticated ? "重新扫码" : "绑定微信"}</h3><button data-action="dismiss-login" aria-label="关闭">×</button></div><p class="muted">${esc(view.login.phase)}</p>${view.login.qrDataUrl ? `<img class="qr" src="${esc(view.login.qrDataUrl)}" alt="微信登录二维码">` : '<div class="loading">正在获取二维码…</div>'}<div class="modal-foot"><span class="muted">关闭窗口不会取消后台登录流程</span></div></div></div>`,
    );
};

void connectWebSurfaceBrowser({
  sessions: (next) => {
    sessions.clear();
    for (const session of next) sessions.set(session.sessionId, session);
    render();
  },
  projection: (session, value) => {
    const view = asView(value);
    if (view?.login === null) loginDismissed = false;
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
    const row = button.closest<HTMLElement>("[data-session]");
    const target = row?.dataset["session"] ? sessions.get(row.dataset["session"]!) : undefined;
    if (action === "dismiss-login") {
      loginDismissed = true;
      render();
      return;
    }
    if (action === "open" && target) {
      client.navigate(`/?session=${encodeURIComponent(target.sessionId)}`);
      return;
    }
    const active = owner();
    if (!active) return;
    const dispatch = () => {
      button.disabled = true;
      if (action === "scan") loginDismissed = false;
      const payload =
        action === "scan"
          ? { _tag: "Scan" }
          : action === "toggle"
            ? { _tag: "SetEnabled", enabled: !active.view.enabled }
            : action === "default" && target
              ? { _tag: "SetDefault", sessionId: target.sessionId, cwd: target.cwd }
              : action === "test"
                ? { _tag: "SendTest" }
                : { _tag: "Logout" };
      void client.dispatch(active.session.sessionId, payload).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
        else client.notify(action === "test" ? "测试消息已发送" : "操作已完成");
        button.disabled = false;
      });
    };
    if (action !== "logout") dispatch();
    else
      void client
        .confirm(
          "解除微信绑定",
          "清除账号凭证、cursor 和发送上下文；默认 Session 与历史路由会保留。",
        )
        .then((confirmed) => {
          if (confirmed) dispatch();
        });
  });
});
