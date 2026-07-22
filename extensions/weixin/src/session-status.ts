import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import type { BridgeStatus } from "./bridge.ts";
import { projectWeixinLivePresentation } from "./presentation.ts";
import type { WeixinStatusProjection } from "./status-projection.ts";

export type { WeixinStatusProjection };

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

export const publishSessionPresentation = (
  presentation: LivePresentationPort | undefined,
  status: WeixinStatusProjection,
): void => {
  presentation?.replace("status", projectWeixinLivePresentation(status));
};
