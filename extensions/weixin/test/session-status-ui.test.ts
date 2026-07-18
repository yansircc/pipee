import { expect, it } from "@effect/vitest";
import type { StructuredView } from "@pi-suite/companion-contracts/host-capabilities";
import {
  publishSessionStatus,
  type WeixinStatusProjection,
  type WeixinStatusUi,
} from "../src/session-status.ts";

const status = (connected: boolean): WeixinStatusProjection => ({
  kind: "pi-weixin/status",
  version: 3,
  enabled: connected,
  accountId: "wx-bot-1",
  defaultSessionId: "session-a",
  connected,
  sendReady: connected,
  phase: connected ? "Connected" : "Stopped",
});

it("publishes structured connection state when the host supports it", () => {
  const structured: Array<WeixinStatusProjection | undefined> = [];
  const text: Array<string | undefined> = [];
  const ui: WeixinStatusUi = {
    setStatus: (_key, value) => text.push(value),
  };
  const view = {
    replace: <T extends StructuredView>(_slot: string, value?: T): void => {
      structured.push(value as WeixinStatusProjection | undefined);
    },
  };

  publishSessionStatus(ui, view, status(true));
  publishSessionStatus(ui, view, status(false));

  expect(structured).toEqual([status(true), status(false)]);
  expect(text).toEqual(["微信已连接", "微信未连接"]);
});

it("publishes the text projection through Pi's public terminal UI contract", () => {
  const text: Array<string | undefined> = [];
  const ui: WeixinStatusUi = {
    setStatus: (_key, value) => text.push(value),
  };

  publishSessionStatus(ui, undefined, status(true));
  publishSessionStatus(ui, undefined, status(false));

  expect(text).toEqual(["微信已连接", "微信未连接"]);
});
