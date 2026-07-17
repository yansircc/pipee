import { describe, expect, it } from "@effect/vitest";
import type { BridgeStatusResponse } from "../../src/protocol/schema.js";
import { projectChromeStatus } from "../../src/pi/status-projection.js";

const extensionDirectory = "/pi-chrome/dist/browser-extension";
const expectation = {
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  displayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
};

const waiting = (): BridgeStatusResponse => ({
  url: "http://127.0.0.1:17318",
  mode: "server",
  extensionExpectation: expectation,
});

const active = (connected: boolean): BridgeStatusResponse => ({
  ...waiting(),
  connector: {
    connectorId: "11111111-1111-4111-8111-111111111111",
    label: "Personal",
    extensionId: expectation.extensionId,
    extensionDisplayVersion: expectation.displayVersion,
    protocolFingerprint: expectation.protocolFingerprint,
    connected,
    ...(connected ? { lastSeenAt: 1_000 } : {}),
    queuedCommands: 0,
    pendingCommands: 0,
  },
});

describe("Chrome status projection", () => {
  it("projects readiness from the single local connector", () => {
    expect(
      projectChromeStatus({ _tag: "Available", status: active(true) }, extensionDirectory),
    ).toMatchObject({
      version: 3,
      state: "ready",
      bridge: "running",
      connector: { label: "Personal", connected: true },
    });
    expect(
      projectChromeStatus({ _tag: "Available", status: active(false) }, extensionDirectory),
    ).toMatchObject({
      state: "offline",
      connector: { connected: false },
    });
  });

  it("waits for an automatically connecting extension without an authorization state", () => {
    expect(
      projectChromeStatus({ _tag: "Available", status: waiting() }, extensionDirectory),
    ).toEqual({
      kind: "pi-chrome/status",
      version: 3,
      state: "waiting-for-extension",
      bridge: "running",
      extensionDirectory,
    });
  });

  it("rejects incompatible connector evidence", () => {
    const status = active(true);
    expect(
      projectChromeStatus(
        {
          _tag: "Available",
          status: {
            ...status,
            extensionExpectation: { ...status.extensionExpectation, displayVersion: "2.0.0" },
          },
        },
        extensionDirectory,
      ),
    ).toMatchObject({
      state: "error",
      errorMessage: "Chrome extension is incompatible: DisplayVersion",
    });
  });

  it("projects bridge failures directly", () => {
    expect(
      projectChromeStatus({ _tag: "Error", message: "owner unreachable" }, extensionDirectory),
    ).toEqual({
      kind: "pi-chrome/status",
      version: 3,
      state: "error",
      bridge: "error",
      extensionDirectory,
      errorMessage: "owner unreachable",
    });
  });
});
