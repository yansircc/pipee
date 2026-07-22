import type { ConversationView } from "@pipee/companion-contracts/conversation-view";
import type { CompanionView } from "@pipee/companion-contracts/companion-view";
import type { WeixinStatusProjection } from "@pipee/companion-contracts/weixin";

const phaseText: Record<WeixinStatusProjection["phase"], string> = {
  Stopped: "已停止",
  Connecting: "正在连接",
  Connected: "运行中",
  Retrying: "连接重试中",
  ReauthenticationRequired: "需要重新登录",
};

export const projectWeixinConversationView = (
  status: WeixinStatusProjection,
): ConversationView => ({
  contract: "pipee/conversation-view@1",
  label: "Weixin",
  tone: status.error
    ? "danger"
    : status.connected
      ? "success"
      : status.enabled
        ? "info"
        : "neutral",
  root: {
    type: "group",
    direction: "column",
    gap: "medium",
    children: [
      {
        type: "group",
        direction: "row",
        gap: "small",
        children: [
          { type: "text", text: "微信连接", variant: "title" },
          {
            type: "badge",
            text: phaseText[status.phase],
            tone: status.error ? "danger" : status.connected ? "success" : "warning",
          },
        ],
      },
      {
        type: "group",
        direction: "row",
        gap: "medium",
        children: [
          { type: "field", label: "账号", value: status.accountId ?? "未登录" },
          { type: "field", label: "默认会话", value: status.defaultSessionId ?? "未设置" },
          { type: "field", label: "主动发送", value: status.sendReady ? "可用" : "不可用" },
        ],
      },
      ...(status.error
        ? ([{ type: "text", text: status.error, variant: "caption", tone: "danger" }] as const)
        : []),
    ],
  },
});

export const projectWeixinCompanionView = (status: WeixinStatusProjection): CompanionView => ({
  contract: "pipee/companion-view@1",
  label: "Weixin",
  state: phaseText[status.phase],
  summary: status.error ?? status.accountId ?? "尚未登录",
  tone: status.error
    ? "danger"
    : status.connected
      ? "success"
      : status.enabled
        ? "warning"
        : "neutral",
  glyph: "messages",
});
