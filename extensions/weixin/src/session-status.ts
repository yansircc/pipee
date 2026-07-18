import type { WeixinStatusProjection } from "@pi-suite/companion-contracts/weixin";
import type { BridgeStatus } from "./bridge.ts";

export type { WeixinStatusProjection };

export interface WeixinStatusUi {
  setStatus(key: string, text: string | undefined): void;
  setStructuredStatus?(key: string, status: WeixinStatusProjection | undefined): void;
}

export const projectSessionStatus = (status: BridgeStatus | undefined): WeixinStatusProjection => ({
  kind: "pi-weixin/status",
  version: 3,
  enabled: status?.enabled ?? false,
  connected: status?.connection._tag === "Connected",
  phase: status?.connection._tag ?? "Stopped",
  sendReady: status?.sendReady ?? false,
  ...(status?.accountId ? { accountId: status.accountId } : {}),
  ...(status?.defaultSessionId ? { defaultSessionId: status.defaultSessionId } : {}),
  ...(status?.lastError ? { error: status.lastError } : {}),
});

export const sameSessionStatus = (
  left: WeixinStatusProjection,
  right: WeixinStatusProjection,
): boolean =>
  left.connected === right.connected &&
  left.enabled === right.enabled &&
  left.phase === right.phase &&
  left.sendReady === right.sendReady &&
  left.accountId === right.accountId &&
  left.defaultSessionId === right.defaultSessionId &&
  left.error === right.error;

export const publishSessionStatus = (ui: WeixinStatusUi, status: WeixinStatusProjection): void => {
  if (typeof ui.setStructuredStatus === "function") {
    ui.setStructuredStatus("weixin", status);
    return;
  }
  ui.setStatus("weixin", status.connected ? "微信已连接" : "微信未连接");
};
