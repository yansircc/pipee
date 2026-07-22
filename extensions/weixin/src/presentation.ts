import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import type { PresentationDocument } from "@pipee/companion-contracts/presentation";
import type { WeixinStatusProjection } from "./status-projection.ts";

const phaseText: Record<WeixinStatusProjection["phase"], string> = {
  Stopped: "已停止",
  Connecting: "正在连接",
  Connected: "运行中",
  Retrying: "连接重试中",
  ReauthenticationRequired: "需要重新登录",
};

export const projectWeixinArtifact = (status: WeixinStatusProjection): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title: "Weixin",
  summary: status.error ?? status.accountId ?? "尚未登录",
  tone: status.error
    ? "danger"
    : status.connected
      ? "success"
      : status.enabled
        ? "info"
        : "neutral",
  icon: "messages",
  status: {
    text: phaseText[status.phase],
    tone: status.error ? "danger" : status.connected ? "success" : "warning",
  },
  body: {
    type: "group",
    direction: "column",
    gap: "medium",
    children: [
      { type: "text", text: "微信连接", variant: "title" },
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

export const projectWeixinLivePresentation = (
  status: WeixinStatusProjection,
): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title: "Weixin",
  summary: status.error ?? status.accountId ?? "尚未登录",
  tone: status.error
    ? "danger"
    : status.connected
      ? "success"
      : status.enabled
        ? "warning"
        : "neutral",
  icon: "messages",
  status: {
    text: phaseText[status.phase],
    tone: status.error ? "danger" : status.connected ? "success" : "warning",
  },
});

export const publishWeixinLivePresentation = (
  presentation: LivePresentationPort | undefined,
  status: WeixinStatusProjection,
): void => {
  presentation?.replace("status", projectWeixinLivePresentation(status));
};
