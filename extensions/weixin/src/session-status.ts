import type { WeixinStatusProjection } from "@pipee/companion-contracts/weixin";
import type { StructuredViewPort } from "@pipee/companion-contracts/host-capabilities";
import { withCompanionView } from "@pipee/extension-kit";
import type { BridgeStatus } from "./bridge.ts";
import { projectWeixinCompanionView } from "./conversation-view.ts";

export type { WeixinStatusProjection };

export interface WeixinStatusUi {
  setStatus(key: string, text: string | undefined): void;
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

export const publishSessionStatus = (
  ui: WeixinStatusUi,
  view: StructuredViewPort | undefined,
  status: WeixinStatusProjection,
): void => {
  view?.replace("status", withCompanionView(status, projectWeixinCompanionView(status)));
  ui.setStatus("weixin", status.connected ? "微信已连接" : "微信未连接");
};
