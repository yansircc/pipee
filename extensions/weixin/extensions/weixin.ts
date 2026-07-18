import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Effect, Exit, Scope, Stream } from "effect";
import QRCode from "qrcode";
import packageJson from "../package.json" with { type: "json" };
import type { MediaViewPort } from "@pi-suite/companion-contracts/host-capabilities";
import {
  makeRuntimeRetentionSlot,
  mediaView,
  structuredView,
  type RuntimeRetentionSlot,
} from "@pi-suite/extension-kit";
import { Bridge, type BridgeStatus } from "../src/bridge.ts";
import { BridgeConfigurationError, QrCodeError } from "../src/errors.ts";
import type { LoginEvent } from "../src/ilink.ts";
import { proactiveClientId } from "../src/message.ts";
import {
  acquirePiWeixinRuntime,
  releasePiWeixinRuntime,
  setPiWeixinRetention,
  type PiWeixinRuntime,
} from "../src/runtime.ts";
import {
  publishSessionStatus,
  projectSessionStatus,
  sameSessionStatus,
} from "../src/session-status.ts";
import { makeStatusSync } from "../src/status-sync.ts";

const sessionFrom = (ctx: ExtensionContext) => ({
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
  const session = status.defaultSessionId
    ? `，默认 session ${status.defaultSessionId}`
    : "，未设置默认 session";
  const send = status.sendReady ? "，可主动发送" : "，尚不可主动发送";
  const error = status.lastError ? `，错误：${status.lastError}` : "";
  return `${state}${account}${session}${send}${error}`;
};

const clearLoginWidget = (ctx: ExtensionContext, image: MediaViewPort | undefined) =>
  Effect.sync(() => {
    ctx.ui.setWidget("weixin-login", undefined);
    image?.replace("login", undefined);
  });

const login = (ctx: ExtensionContext) =>
  Effect.gen(function* () {
    if (!ctx.hasUI) {
      return yield* new BridgeConfigurationError({ reason: "微信登录需要可交互 UI" });
    }
    const bridge = yield* Bridge;
    const image = mediaView(ctx.ui, packageJson.name);
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
              if (!image) {
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
                image.replace("login", {
                  dataUrl,
                  alt: "微信登录二维码",
                  width: 384,
                  height: 384,
                });
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
      .connect(callbacks, sessionFrom(ctx))
      .pipe(Effect.ensuring(clearLoginWidget(ctx, image)));
    return auth;
  });

const connect = (ctx: ExtensionContext) =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    const current = yield* bridge.status;
    if (!current.accountId) {
      yield* login(ctx);
    } else {
      if (!current.defaultSessionId) yield* bridge.setDefaultSession(sessionFrom(ctx));
      yield* bridge.setEnabled(true);
    }
    return yield* bridge.status;
  });

const toolResult = (text: string, details: unknown): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});

export default function weixinExtension(pi: ExtensionAPI): void {
  let runtime: PiWeixinRuntime | undefined;
  let activeSessionId: string | undefined;
  let retentionScope: Scope.Closeable | undefined;
  const statusSync = makeStatusSync();

  const requireRuntime = (): PiWeixinRuntime => {
    return runtime!;
  };

  const startStatusSync = (ctx: ExtensionContext) =>
    statusSync.replace(
      Effect.gen(function* () {
        const bridge = yield* Bridge;
        const statusView = structuredView(ctx.ui, packageJson.name);
        yield* bridge.statusChanges.pipe(
          Stream.map(
            Exit.match({
              onFailure: () => projectSessionStatus(undefined),
              onSuccess: projectSessionStatus,
            }),
          ),
          Stream.changesWith(sameSessionStatus),
          Stream.runForEach((status) =>
            Effect.sync(() => setPiWeixinRetention(status.enabled)).pipe(
              Effect.andThen(Effect.sync(() => publishSessionStatus(ctx.ui, statusView, status))),
            ),
          ),
        );
      }),
    );

  pi.registerTool({
    name: "weixin_connect",
    label: "Connect Weixin",
    description:
      "Ensure the global Weixin account is logged in and running. The current session becomes the default only when none exists.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal, _onUpdate, context) {
      return requireRuntime().runPromise(
        connect(context).pipe(
          Effect.map((status) =>
            toolResult(`Weixin connected: ${formatStatus(status)}`, {
              accountId: status.accountId,
              defaultSessionId: status.defaultSessionId,
              sendReady: status.sendReady,
              phase: status.connection._tag,
            }),
          ),
        ),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_set_default",
    label: "Set Default Weixin Session",
    description: "Make the current Pi session the destination for unquoted Weixin messages.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal, _onUpdate, context) {
      return requireRuntime().runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.setDefaultSession(sessionFrom(context));
          const status = yield* bridge.status;
          return toolResult(`Default Weixin session set to ${status.defaultSessionId}.`, {
            defaultSessionId: status.defaultSessionId,
          });
        }),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_send",
    label: "Send Weixin Message",
    description:
      "Send text to the global Weixin account. A quoted reply returns to the current Pi session.",
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    execute(id, parameters, signal, _onUpdate, context) {
      return requireRuntime().runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          const sessionId = context.sessionManager.getSessionId();
          const serverMessageId = yield* bridge.sendText(
            sessionId,
            parameters.text ?? "",
            proactiveClientId(sessionId, id),
          );
          return toolResult("Weixin message sent.", { serverMessageId });
        }),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_disconnect",
    label: "Disconnect Weixin",
    description:
      "Stop the global Weixin bridge while preserving credentials, default session, and routes.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return requireRuntime().runPromise(
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
    description:
      "Stop Weixin and clear the account, cursor, and send context while preserving the default session.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return requireRuntime().runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* bridge.logout;
          return toolResult(
            "Weixin logged out. Default session and route history were preserved.",
            {
              loggedIn: false,
            },
          );
        }),
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "weixin_status",
    label: "Inspect Weixin Status",
    description:
      "Read the global Weixin account, default session, proactive-send readiness, and connection status.",
    parameters: Type.Object({}),
    execute(_id, _parameters, signal) {
      return requireRuntime().runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          const status = yield* bridge.status;
          return toolResult(formatStatus(status), {
            accountId: status.accountId,
            defaultSessionId: status.defaultSessionId,
            sendReady: status.sendReady,
            enabled: status.enabled,
            phase: status.connection._tag,
            lastError: status.lastError,
          });
        }),
        { signal },
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    let retained = false;
    let retention: RuntimeRetentionSlot | undefined;
    let scope: Scope.Closeable | undefined;
    const value = acquirePiWeixinRuntime({
      sessionId,
      setRetained: (next) => {
        retained = next;
        retention?.replace(next ? { reason: "global-bridge-enabled" } : undefined);
      },
    });
    runtime = value;
    activeSessionId = sessionId;
    return value
      .runPromise(
        Effect.gen(function* () {
          scope = yield* Scope.make("sequential");
          retention = yield* makeRuntimeRetentionSlot(
            ctx.ui,
            packageJson.name,
            "global-bridge",
          ).pipe(Effect.provideService(Scope.Scope, scope));
          retentionScope = scope;
          retention.replace(retained ? { reason: "global-bridge-enabled" } : undefined);
          const bridge = yield* Bridge;
          yield* startStatusSync(ctx);
          yield* bridge.start;
        }).pipe(
          Effect.tapCause((cause) =>
            Effect.gen(function* () {
              if (scope) yield* Scope.close(scope, Exit.failCause(cause));
              runtime = undefined;
              activeSessionId = undefined;
              retentionScope = undefined;
            }),
          ),
        ),
      )
      .catch((error) =>
        Promise.resolve(releasePiWeixinRuntime(sessionId)).then(() => Promise.reject(error)),
      );
  });

  pi.on("session_shutdown", () => {
    const currentRuntime = runtime;
    const sessionId = activeSessionId;
    const scope = retentionScope;
    if (!currentRuntime || !sessionId) return;
    return currentRuntime
      .runPromise(
        Effect.gen(function* () {
          const bridge = yield* Bridge;
          yield* statusSync.close;
          yield* bridge.releaseSession(sessionId);
          if (scope) yield* Scope.close(scope, Exit.succeed(undefined));
          runtime = undefined;
          activeSessionId = undefined;
          retentionScope = undefined;
        }),
      )
      .finally(() => releasePiWeixinRuntime(sessionId));
  });
}
