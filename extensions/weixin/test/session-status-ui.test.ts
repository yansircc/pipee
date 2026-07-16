import { expect, it } from "@effect/vitest";
import {
  publishSessionStatus,
  type WeixinStatusProjection,
  type WeixinStatusUi,
} from "../src/session-status.ts";

const status = (connected: boolean): WeixinStatusProjection => ({
  kind: "pi-weixin/status",
  version: 2,
  bindings: [
    {
      sessionId: "session-a",
      accountId: "wx-bot-1",
      connected,
      phase: connected ? "Connected" : "Stopped",
    },
  ],
});

it("publishes structured connection state when the host supports it", () => {
  const structured: Array<WeixinStatusProjection | undefined> = [];
  const text: Array<string | undefined> = [];
  const ui: WeixinStatusUi = {
    setStructuredStatus: (_key, value) => structured.push(value),
    setStatus: (_key, value) => text.push(value),
  };

  publishSessionStatus(ui, status(true), "session-a");
  publishSessionStatus(ui, status(false), "session-a");

  expect(structured).toEqual([status(true), status(false)]);
  expect(text).toEqual([]);
});

it("publishes the text projection through Pi's public terminal UI contract", () => {
  const text: Array<string | undefined> = [];
  const ui: WeixinStatusUi = {
    setStatus: (_key, value) => text.push(value),
  };

  publishSessionStatus(ui, status(true), "session-a");
  publishSessionStatus(ui, status(false), "session-a");

  expect(text).toEqual(["微信已连接", "微信未连接"]);
});
