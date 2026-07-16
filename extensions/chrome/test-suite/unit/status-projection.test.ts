import { describe, expect, it } from "@effect/vitest";
import type { BridgeStatusResponse } from "../../src/protocol/schema.js";
import type { SessionAuthorizationSnapshot } from "../../src/pi/session-runtime-owner.js";
import { projectChromeStatus } from "../../src/pi/status-projection.js";

const active = (
  authorization: Extract<SessionAuthorizationSnapshot, { _tag: "Active" }>["authorization"],
): SessionAuthorizationSnapshot => ({
  _tag: "Active",
  epoch: 1,
  authorization,
  authorized: authorization.state !== "locked",
  background: false,
  expiry: undefined,
});

const extensionDirectory = "/pi-chrome/dist/browser-extension";

const bridge = (connected: boolean): BridgeStatusResponse => ({
  url: "http://127.0.0.1:17318",
  mode: "server",
  sessionRoutes: [],
  protocolCompatibility: {
    compatible: true,
    expectedExtensionDisplayVersion: "1.0.0",
  },
  binding: {
    connectorId: "11111111-1111-4111-8111-111111111111",
    label: "Personal",
    pairedAt: 1_000,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionDisplayVersion: "1.0.0",
    protocolFingerprint: "a".repeat(64),
  },
  connector: {
    connectorId: "11111111-1111-4111-8111-111111111111",
    label: "Personal",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionDisplayVersion: "1.0.0",
    protocolFingerprint: "a".repeat(64),
    connected,
    ...(connected ? { lastSeenAt: 1_000 } : {}),
    queuedCommands: 0,
    pendingCommands: 0,
  },
});

describe("Chrome status projection", () => {
  it("requires both authorization and a live connector for ready", () => {
    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Available", status: bridge(true) },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "ready",
      authorization: "indefinite",
      connection: "connected",
      connectorLabel: "Personal",
      bridge: "running",
    });
    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Available", status: bridge(false) },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "offline",
      connection: "offline",
    });
  });

  it("projects the session connector instead of the unrelated terminal binding", () => {
    const status = bridge(false);
    const sessionRoute = {
      source: "web",
      sessionKey: "session:web",
      generation: "22222222-2222-4222-8222-222222222222",
      availability: "live",
      claim: {
        pairingId: "22222222-2222-4222-8222-222222222222",
        leaseToken: "b".repeat(64),
        connectorId: "22222222-2222-4222-8222-222222222222",
        sessionKey: "session:web",
      },
      connector: {
        connectorId: "22222222-2222-4222-8222-222222222222",
        label: "Current Web Profile",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        extensionDisplayVersion: "1.0.0",
        protocolFingerprint: "a".repeat(64),
      },
      expiresAt: 721_000,
      connected: true,
    } as const;

    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Available", status: { ...status, sessionRoutes: [sessionRoute] } },
        1_000,
        extensionDirectory,
        "session:web",
      ),
    ).toMatchObject({
      readiness: "ready",
      connection: "connected",
      connectorId: sessionRoute.connector.connectorId,
      connectorLabel: "Current Web Profile",
      connectorExpiresAt: 721_000,
    });
  });

  it("keeps an expired session route distinct from the terminal connector", () => {
    const status = bridge(true);
    const sessionRoute = {
      source: "web",
      sessionKey: "session:web",
      generation: "22222222-2222-4222-8222-222222222222",
      availability: "expired",
      connector: {
        connectorId: "22222222-2222-4222-8222-222222222222",
        label: "Expired Web Profile",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        extensionDisplayVersion: "1.0.0",
        protocolFingerprint: "a".repeat(64),
      },
      connected: false,
    } as const;

    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Available", status: { ...status, sessionRoutes: [sessionRoute] } },
        1_000,
        extensionDirectory,
        "session:web",
      ),
    ).toMatchObject({
      readiness: "offline",
      connection: "unavailable",
      connectorId: sessionRoute.connector.connectorId,
      connectorLabel: "Expired Web Profile",
    });
  });

  it("projects locked independently from connector connectivity", () => {
    expect(
      projectChromeStatus(
        active({ state: "locked" }),
        { _tag: "Available", status: bridge(true) },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "locked",
      authorization: "locked",
      connection: "connected",
    });
  });

  it("keeps the absolute timed authorization deadline", () => {
    expect(
      projectChromeStatus(
        active({ state: "timed", deadline: 721_000 }),
        { _tag: "Available", status: bridge(true) },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "ready",
      authorization: { expiresAt: 721_000 },
    });
  });

  it("projects the bridge-owned protocol verdict with one reload action", () => {
    const status = bridge(true);
    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        {
          _tag: "Available",
          status: {
            ...status,
            protocolCompatibility: {
              compatible: false,
              extensionId: "abcdefghijklmnopabcdefghijklmnop",
              expectedExtensionDisplayVersion: "0.1.5",
              actualExtensionDisplayVersion: "0.16.0",
            },
          },
        },
        1_000,
        extensionDirectory,
      ).requirements[0],
    ).toEqual({
      requirement: "ProtocolCompatible",
      satisfied: false,
      expectedVersion: "0.1.5",
      actualVersion: "0.16.0",
      remediation: {
        type: "ReloadUnpackedExtension",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        directory: extensionDirectory,
      },
    });
  });

  it("makes bridge and ledger failures red regardless of authorization", () => {
    expect(
      projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Error", message: "owner unreachable" },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "error",
      bridge: "error",
      errorMessage: "owner unreachable",
    });
    expect(
      projectChromeStatus(
        { _tag: "Poisoned", epoch: 1, background: false },
        { _tag: "Available", status: bridge(true) },
        1_000,
        extensionDirectory,
      ),
    ).toMatchObject({
      readiness: "error",
      errorMessage: "Chrome authorization ledger is fail-closed",
    });
  });
});
