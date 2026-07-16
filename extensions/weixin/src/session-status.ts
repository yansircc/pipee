import type { WeixinStatusProjection } from "@pi-suite/companion-contracts/weixin";
import type { BridgeStatus } from "./bridge.ts";

export type { WeixinStatusProjection };

export interface WeixinStatusUi {
  setStatus(key: string, text: string | undefined): void;
  setStructuredStatus?(key: string, status: WeixinStatusProjection | undefined): void;
}

export const projectSessionStatus = (status: BridgeStatus | undefined): WeixinStatusProjection => ({
  kind: "pi-weixin/status",
  version: 2,
  bindings: status?.sessionId
    ? [
        {
          sessionId: status.sessionId,
          ...(status.accountId ? { accountId: status.accountId } : {}),
          connected: status.connection._tag === "Connected",
          phase: status.connection._tag,
          ...(status.lastError ? { error: status.lastError } : {}),
        },
      ]
    : [],
});

export const sameSessionStatus = (
  left: WeixinStatusProjection,
  right: WeixinStatusProjection,
): boolean => {
  if (left.bindings.length !== right.bindings.length) return false;
  const rightBySession = new Map(right.bindings.map((binding) => [binding.sessionId, binding]));
  return left.bindings.every((binding) => {
    const candidate = rightBySession.get(binding.sessionId);
    return (
      candidate !== undefined &&
      binding.accountId === candidate.accountId &&
      binding.connected === candidate.connected &&
      binding.phase === candidate.phase &&
      binding.error === candidate.error
    );
  });
};

export const publishSessionStatus = (
  ui: WeixinStatusUi,
  status: WeixinStatusProjection,
  currentSessionId: string,
): void => {
  if (typeof ui.setStructuredStatus === "function") {
    ui.setStructuredStatus("weixin", status);
    return;
  }
  // Pi's public Extension UI contract exposes setStatus; pi-web additionally
  // consumes the structured projection.
  const binding = status.bindings.find((candidate) => candidate.sessionId === currentSessionId);
  ui.setStatus("weixin", binding ? (binding.connected ? "微信已连接" : "微信未连接") : undefined);
};
