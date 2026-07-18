import { expect, it } from "@effect/vitest";
import type { BridgeStatus } from "../src/bridge.ts";
import { projectSessionStatus, sameSessionStatus } from "../src/session-status.ts";

const running = (defaultSessionId: string): BridgeStatus => ({
  running: true,
  enabled: true,
  authenticated: true,
  accountId: "wx-bot-1",
  defaultSessionId,
  sendReady: true,
  connection: { _tag: "Connected" },
});

it("projects one global Weixin status", () => {
  expect(projectSessionStatus(running("session-a"))).toEqual({
    kind: "pi-weixin/status",
    version: 3,
    enabled: true,
    connected: true,
    phase: "Connected",
    sendReady: true,
    accountId: "wx-bot-1",
    defaultSessionId: "session-a",
  });
});

it("projects disconnected when the bridge stops or status cannot be read", () => {
  expect(
    projectSessionStatus({
      ...running("session-a"),
      running: false,
      connection: { _tag: "Stopped" },
    }).connected,
  ).toBe(false);
  expect(projectSessionStatus(undefined)).toMatchObject({
    enabled: false,
    connected: false,
    sendReady: false,
  });
});

it("compares every global status field", () => {
  const left = projectSessionStatus(running("session-a"));
  expect(sameSessionStatus(left, { ...left })).toBe(true);
  expect(sameSessionStatus(left, { ...left, defaultSessionId: "session-b" })).toBe(false);
  expect(sameSessionStatus(left, { ...left, sendReady: false })).toBe(false);
});
