import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Effect, Exit, Stream } from "effect";
import QRCode from "qrcode";
import { Bridge, type BridgeStatus } from "../src/bridge.ts";
import { BridgeConfigurationError, QrCodeError } from "../src/errors.ts";
import type { LoginEvent } from "../src/ilink.ts";
import { getPiWeixinRuntime } from "../src/runtime.ts";
import {
  publishSessionStatus,
  projectSessionStatus,
  sameSessionStatus,
} from "../src/session-status.ts";
import { makeStatusSync } from "../src/status-sync.ts";

interface ImageWidgetUi {
  setImageWidget?: (
    key: string,
    image:
      | {
          dataUrl: string;
          alt: string;
          width: number;
          height: number;
        }
      | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
}

const bindingFrom = (ctx: ExtensionContext) => ({
  sessionId: ctx.sessionManager.getSessionId(),
  sessionFile: ctx.sessionManager.getSessionFile(),
  cwd: ctx.cwd,
});

const formatStatus = (status: BridgeStatus): string => {
  const labels: Record<BridgeStatus["connection"]["_tag"], string> = {
    Stopped: status.enabled ? "等待启动" : "已停止",
    Connecting: "正在连接",
    Connected: "运行中",
    Retrying: "连接重试中",
    ReauthenticationRequired: "需要重新登录",
  };
  const state = labels[status.connection._tag];
  const account = status.accountId ? `，微信 ${status.accountId}` : "，未登录";
  const session = status.sessionId ? `，session ${status.sessionId}` : "，未绑定 session";
  const error = status.lastError ? `，错误：${status.lastError}` : "";
  return `${state}${account}${session}${error}`;
};

const clearLoginWidget = (ctx: ExtensionContext, imageUi: ImageWidgetUi) =>
  Effect.sync(() => {
    ctx.ui.setWidget("weixin-login", undefined);
    imageUi.setImageWidget?.("weixin-login", undefined);
  });

const login = (ctx: ExtensionContext) =>
  Effect.gen(function* () {
    if (!ctx.hasUI) {
      return yield* new BridgeConfigurationError({ reason: "微信登录需要可交互 UI" });
    }
    const bridge = yield* Bridge;
    const imageUi = ctx.ui as typeof ctx.ui & ImageWidgetUi;
    const eventMessages: Record<LoginEvent["_tag"], (event: LoginEvent) => string> = {
      AwaitingScan: () => "等待微信扫码",
      Scanned: () => "已扫码，请在微信确认",
      AwaitingVerifyCode: (event) =>
        event._tag === "AwaitingVerifyCode" && event.retry
          ? "配对码不匹配，请重新输入"
          : "微信要求输入配对码",
      VerifyCodeAccepted: () => "配对码已接受，请在微信确认",
      QrRefreshed: () => "二维码已刷新，请重新扫码",
      Redirected: () => "已切换到微信区域节点",
      PollingRetry: () => "微信登录连接波动，正在重试",
      AlreadyConnected: () => "该微信账号已连接，正在复用本地凭证",
    };
    const callbacks = {
      onQr: (content: string) =>
        ctx.mode === "tui"
          ? Effect.tryPromise({
              try: () => QRCode.toString(content, { type: "utf8" }),
              catch: (cause) => new QrCodeError({ cause }),
            }).pipe(
              Effect.tap((qr) =>
                Effect.sync(() => {
                  ctx.ui.setWidget(
                    "weixin-login",
                    ["请用微信扫描：", ...qr.trimEnd().split("\n")],
                    {
                      placement: "aboveEditor",
                    },
                  );
                }),
              ),
              Effect.asVoid,
            )
          : Effect.gen(function* () {
              if (!imageUi.setImageWidget) {
                return yield* new BridgeConfigurationError({
                  reason: "当前宿主不支持图片 Widget，请更新 pi-web",
                });
              }
              const dataUrl = yield* Effect.tryPromise({
                try: () =>
                  QRCode.toDataURL(content, {
                    errorCorrectionLevel: "M",
                    margin: 4,
                    width: 384,
                  }),
                catch: (cause) => new QrCodeError({ cause }),
              });
              yield* Effect.sync(() => {
                imageUi.setImageWidget?.(
                  "weixin-login",
                  {
                    dataUrl,
                    alt: "微信登录二维码",
                    width: 384,
                    height: 384,
                  },
                  { placement: "aboveEditor" },
                );
              });
            }),
      onEvent: (event: LoginEvent) =>
        Effect.sync(() => ctx.ui.notify(eventMessages[event._tag](event), "info")),
      requestVerifyCode: (retry: boolean) =>
        Effect.tryPromise({
          try: () =>
            ctx.ui.input(retry ? "配对码不匹配，请重新输入" : "输入手机微信显示的配对码", "配对码"),
          catch: (cause) => new QrCodeError({ cause }),
        }).pipe(
          Effect.flatMap((value) =>
            value
              ? Effect.succeed(value)
              : Effect.fail(new BridgeConfigurationError({ reason: "微信配对码输入已取消" })),
          ),
        ),
    };
    const auth = yield* bridge
      .loginAndBind(callbacks, bindingFrom(ctx))
      .pipe(Effect.ensuring(clearLoginWidget(ctx, imageUi)));
    return auth;
  });

const connect = (ctx: ExtensionContext) =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    const current = yield* bridge.status;
    if (!current.accountId) {
      yield* login(ctx);
    } else {
      yield* bridge.bind(bindingFrom(ctx));
      yield* bridge.setEnabled(true);
    }
    return yield* bridge.status;
  });

const toolResult = (text: string, details: unknown): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});

export default function weixinExtension(pi: ExtensionAPI): void {
  const runtime = getPiWeixinRuntime();
  let activeSessionId: string | undefined;
  const statusSync = makeStatusSync();

  const startStatusSync = (ctx: ExtensionContext) =>
    statusSync.replace(
      Effect.gen(function* () {
        const bridge = yield* Bridge;
        const sessionId = ctx.sessionManager.getSessionId();
        yield* bridge.statusChanges.pipe(
          Stream.map(
            Exit.match({
              onFailure: () => projectSessionStatus(undefined),
              onSuccess: projectSessionStatus,
            }),
          ),
          Stream.changesWith(sameSessionStatus),
          Stream.runForEach((status) =>
            Effect.sync(() => {
              publishSessionStatus(ctx.ui, status, sessionId);
            }),
          ),
        );
      }),
    );

  pi.registerTool({
    name: "weixin_connect",
    label: "Connect Weixin",
    description:
      "Ensure Weixin is logged in, bound to this Pi session, and running. Shows a QR code when login is required.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal, _onUpdate, context) {
      return runtime.runPromise(
        connect(context).pipe(
          Effect.map((status) =>
            toolResult(`Weixin connected: ${formatStatus(status)}`, {
              accountId: status.accountId,
              sessionId: status.sessionId,
              phase: status.connection._tag,
            }),
          ),
        ),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_disconnect",
    label: "Disconnect Weixin",
    description: "Stop the Weixin bridge while preserving login credentials and session binding.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.setEnabled(false);
          const status = yield* bridge.status;
          return toolResult(`Weixin disconnected: ${formatStatus(status)}`, {
            phase: status.connection._tag,
          });
        }),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_logout",
    label: "Log Out Weixin",
    description: "Stop Weixin and clear the stored account, cursor, and Pi session binding.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.logout;
          return toolResult("Weixin logged out and local binding cleared.", { loggedIn: false });
        }),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_status",
    label: "Inspect Weixin Status",
    description: "Read the current Weixin account, session binding, and connection status.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          const status = yield* bridge.status;
          return toolResult(formatStatus(status), {
            accountId: status.accountId,
            sessionId: status.sessionId,
            enabled: status.enabled,
            phase: status.connection._tag,
            lastError: status.lastError,
          });
        }),
        { signal },
      );
    },
  });

  pi.on("session_start", (_event, ctx) =>
    runtime.runPromise(
      Effect.gen(function* () {
        activeSessionId = ctx.sessionManager.getSessionId();
        const bridge = yield* Bridge;
        yield* startStatusSync(ctx);
        yield* bridge.start;
      }),
    ),
  );

  pi.on("session_shutdown", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const bridge = yield* Bridge;
        yield* statusSync.close;
        if (activeSessionId !== undefined) yield* bridge.releaseSession(activeSessionId);
        activeSessionId = undefined;
      }),
    ),
  );
}
