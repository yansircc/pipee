import { connectWebSurfaceBrowser } from "@pi-suite/companion-contracts/web-surface-browser";
import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";

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
let view: View | null = null;
const esc = (value: string | number | null | undefined) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const asView = (value: JsonValue | null): View | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as View) : null;

const render = () => {
  if (!view) return;
  const connected = view.phase === "Connected";
  root.innerHTML = `<div class="shell"><header class="top"><div><h1>微信桥接</h1><p>session-bound Web Surface · @yansircc/pi-weixin</p></div><span class="live"><i class="dot"></i>Runtime projection</span></header>
  <main class="content"><section class="hero"><div class="account"><div class="mark">微</div><div><h2>${view.authenticated ? "微信账号已连接" : "尚未绑定微信"}</h2><div class="muted">${view.account ? `account · ${esc(view.account)}` : "扫描二维码完成绑定"}</div><div class="state"><i class="dot"></i>${esc(view.phase)}${connected ? " · 长轮询正常" : ""}</div><div class="actions">${view.authenticated ? `<button data-action="scan">重新扫码</button><button data-action="toggle">${view.enabled ? "暂停桥接" : "恢复桥接"}</button><button class="danger" data-action="logout">解除绑定</button>` : `<button class="primary" data-action="scan">扫码绑定微信</button>`}</div></div></div>
  <div class="metric"><span>登录凭证</span><strong class="${view.authenticated ? "ok" : ""}">${view.authenticated ? "有效" : "未绑定"}</strong><p class="muted">${view.authenticated ? "可重新扫码替换" : "需要微信扫码"}</p></div><div class="metric"><span>主动发送</span><strong class="${view.sendReady ? "ok" : ""}">${view.sendReady ? "已就绪" : "未就绪"}</strong><p class="muted">依赖最近消息上下文</p></div></section>
  <div class="section-title"><h3>消息路由</h3><p>桥接只决定消息进入哪个 Pi Session，不复制聊天界面</p></div><div class="grid"><section class="card"><h4>固定路由规则</h4><div class="route"><div><b>普通微信消息</b><span class="muted">没有引用 Pi 回复</span></div><i class="arrow"></i><div><b>默认 Session</b><span class="muted">${esc(view.defaultSessionId ?? "尚未设置")}</span></div></div><div class="route"><div><b>引用 Pi 回复</b><span class="muted">携带原消息 identity</span></div><i class="arrow"></i><div><b>原始来源 Session</b><span class="muted">精确回到发出消息的会话</span></div></div><div class="note">无法识别引用来源时 fail closed，不猜测并投递到默认 Session。</div></section><section class="card"><h4>桥接健康</h4><div class="health-row"><i class="dot"></i><div><b>iLink 长轮询</b><p class="muted">${esc(view.phase)}</p></div></div><div class="health-row"><i class="dot"></i><div><b>Pi Gateway</b><p class="muted">Session dispatch 由 Runtime 持有</p></div></div><div class="health-row"><i class="dot"></i><div><b>账号 ownership</b><p class="muted">单账号跨进程 lease</p></div></div></section></div>
  <div class="section-title"><h3>当前 Session</h3><p>可设为未引用消息的默认目标</p></div><section class="card session"><div><b>${esc(view.sessionId)}</b><p class="muted">${esc(view.cwd)}</p></div><div class="session-buttons"><button data-action="open">打开对话 ↗</button><button data-action="default" ${view.defaultSessionId === view.sessionId ? "disabled" : ""}>${view.defaultSessionId === view.sessionId ? "当前默认" : "设为默认"}</button><button data-action="test" ${view.sendReady ? "" : "disabled"}>发送测试</button></div></section>${view.error ? `<p class="error">${esc(view.error)}</p>` : ""}</main></div>`;
  if (view.login)
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="overlay"><div class="modal"><h3>${view.authenticated ? "重新扫码" : "绑定微信"}</h3><p class="muted">${esc(view.login.phase)}</p>${view.login.qrDataUrl ? `<img class="qr" src="${esc(view.login.qrDataUrl)}" alt="微信登录二维码">` : '<div class="loading">正在获取二维码…</div>'}<div class="modal-foot"><span class="muted">请在微信中完成确认</span></div></div></div>`,
    );
};

void connectWebSurfaceBrowser({
  projection: (next) => {
    view = asView(next);
    render();
  },
}).then((client) => {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!button || !view || button.disabled) return;
    const action = button.dataset["action"];
    if (action === "open")
      return client.navigate(`/?session=${encodeURIComponent(view.sessionId)}`);
    const dispatch = () => {
      button.disabled = true;
      const payload =
        action === "scan"
          ? { _tag: "Scan" }
          : action === "toggle"
            ? { _tag: "SetEnabled", enabled: !view!.enabled }
            : action === "default"
              ? { _tag: "SetDefault" }
              : action === "test"
                ? { _tag: "SendTest" }
                : { _tag: "Logout" };
      void client.dispatch(payload).then((outcome) => {
        if (outcome._tag !== "Accepted")
          client.notify(outcome._tag === "Rejected" ? outcome.reason : outcome.message, "error");
        else client.notify(action === "test" ? "测试消息已发送" : "操作已完成");
        button.disabled = false;
      });
    };
    if (action !== "logout") return dispatch();
    void client
      .confirm("解除微信绑定", "清除账号凭证、cursor 和发送上下文；默认 Session 与历史路由会保留。")
      .then((confirmed) => {
        if (confirmed) dispatch();
      });
  });
});
