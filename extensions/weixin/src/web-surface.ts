import { Schema } from "effect";
import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";
import type { BridgeStatus } from "./bridge.ts";

export const WeixinWebAction = Schema.Union([
  Schema.TaggedStruct("Scan", {}),
  Schema.TaggedStruct("SetEnabled", { enabled: Schema.Boolean }),
  Schema.TaggedStruct("SetDefault", {}),
  Schema.TaggedStruct("SendTest", {}),
  Schema.TaggedStruct("Logout", {}),
]);
export type WeixinWebAction = typeof WeixinWebAction.Type;

export interface WeixinLoginProjection {
  readonly phase: string;
  readonly qrDataUrl?: string;
}

export const projectWeixinWebView = (
  status: BridgeStatus | undefined,
  sessionId: string,
  cwd: string,
  login?: WeixinLoginProjection,
): JsonValue => ({
  kind: "pi-weixin/web-surface",
  version: 1,
  sessionId,
  cwd,
  account: status?.accountId ?? null,
  authenticated: status?.authenticated ?? false,
  enabled: status?.enabled ?? false,
  running: status?.running ?? false,
  sendReady: status?.sendReady ?? false,
  phase: status?.connection._tag ?? "Stopped",
  defaultSessionId: status?.defaultSessionId ?? null,
  error: status?.lastError ?? null,
  login: login === undefined ? null : { phase: login.phase, qrDataUrl: login.qrDataUrl ?? null },
});
