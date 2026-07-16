import { expect, it } from "@effect/vitest";
import type { BridgeStatus } from "../src/bridge.ts";
import { projectSessionStatus, sameSessionStatus } from "../src/session-status.ts";

const running = (sessionId: string): BridgeStatus => ({
  running: true,
  enabled: true,
  authenticated: true,
  accountId: "wx-bot-1",
  sessionId,
  connection: { _tag: "Connected" },
});

it("shows the connection only on the bound session", () => {
  const status = running("session-a");
  expect(projectSessionStatus(status)).toEqual({
    kind: "pi-weixin/status",
    version: 2,
    bindings: [
      {
        sessionId: "session-a",
        accountId: "wx-bot-1",
        connected: true,
        phase: "Connected",
      },
    ],
  });
});

it("moves the connection projection when the binding changes", () => {
  const before = running("session-a");
  const after = running("session-b");

  expect(projectSessionStatus(before).bindings[0]?.sessionId).toBe("session-a");
  expect(projectSessionStatus(after).bindings[0]?.sessionId).toBe("session-b");
});

it("projects disconnected when the bridge stops or status cannot be read", () => {
  expect(
    projectSessionStatus({
      ...running("session-a"),
      running: false,
      connection: { _tag: "Stopped" },
    }).bindings[0]?.connected,
  ).toBe(false);
  expect(projectSessionStatus(undefined).bindings).toEqual([]);
});

it("compares bindings by identity rather than projection order", () => {
  const left = {
    kind: "pi-weixin/status" as const,
    version: 2 as const,
    bindings: [
      { sessionId: "session-a", accountId: "wx-a", connected: true, phase: "Connected" as const },
      { sessionId: "session-b", accountId: "wx-b", connected: false, phase: "Stopped" as const },
    ],
  };
  expect(sameSessionStatus(left, { ...left, bindings: [...left.bindings].reverse() })).toBe(true);
});
