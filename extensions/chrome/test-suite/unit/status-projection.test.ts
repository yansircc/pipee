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
  extensionExpectation: {
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    displayVersion: "1.0.0",
    protocolFingerprint: "a".repeat(64),
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

  it("does not let interleaved connector evidence change another session verdict", () => {
    const status = bridge(false);
    const route = (
      sessionKey: string,
      connectorId: string,
      extensionDisplayVersion: string,
      protocolFingerprint: string,
    ) =>
      ({
        source: "web",
        sessionKey,
        generation: connectorId,
        availability: "live",
        claim: {
          pairingId: connectorId,
          leaseToken: "b".repeat(64),
          connectorId,
          sessionKey,
        },
        connector: {
          connectorId,
          label: sessionKey,
          extensionId: "abcdefghijklmnopabcdefghijklmnop",
          extensionDisplayVersion,
          protocolFingerprint,
        },
        expiresAt: 721_000,
        connected: true,
      }) as const;
    const compatible = route(
      "session:compatible",
      "22222222-2222-4222-8222-222222222222",
      "1.0.0",
      "a".repeat(64),
    );
    const incompatible = route(
      "session:incompatible",
      "33333333-3333-4333-8333-333333333333",
      "0.9.0",
      "b".repeat(64),
    );

    for (const sessionRoutes of [
      [compatible, incompatible],
      [incompatible, compatible],
    ]) {
      const bridgeSnapshot = {
        _tag: "Available" as const,
        status: { ...status, sessionRoutes },
      };
      const compatibleStatus = projectChromeStatus(
        active({ state: "indefinite" }),
        bridgeSnapshot,
        1_000,
        extensionDirectory,
        compatible.sessionKey,
      );
      expect(compatibleStatus).toMatchObject({
        readiness: "ready",
        connectorId: compatible.connector.connectorId,
      });
      expect(compatibleStatus.requirements[0]).toEqual({
        requirement: "ProtocolCompatible",
        satisfied: true,
      });
      const incompatibleStatus = projectChromeStatus(
        active({ state: "indefinite" }),
        bridgeSnapshot,
        1_000,
        extensionDirectory,
        incompatible.sessionKey,
      );
      expect(incompatibleStatus).toMatchObject({
        readiness: "error",
        connectorId: incompatible.connector.connectorId,
      });
      expect(incompatibleStatus.requirements[0]).toMatchObject({
        requirement: "ProtocolCompatible",
        satisfied: false,
        mismatches: ["DisplayVersion", "ProtocolFingerprint"],
      });
    }
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

  it("classifies extension id, display version, and fingerprint from one evidence algebra", () => {
    const status = bridge(true);
    const cases = [
      {
        expectation: { ...status.extensionExpectation, extensionId: "b".repeat(32) },
        mismatch: "ExtensionId",
      },
      {
        expectation: { ...status.extensionExpectation, displayVersion: "2.0.0" },
        mismatch: "DisplayVersion",
      },
      {
        expectation: { ...status.extensionExpectation, protocolFingerprint: "b".repeat(64) },
        mismatch: "ProtocolFingerprint",
      },
    ] as const;

    for (const { expectation, mismatch } of cases) {
      const projected = projectChromeStatus(
        active({ state: "indefinite" }),
        { _tag: "Available", status: { ...status, extensionExpectation: expectation } },
        1_000,
        extensionDirectory,
      );
      expect(projected).toMatchObject({ readiness: "error" });
      expect(projected.requirements[0]).toEqual({
        requirement: "ProtocolCompatible",
        satisfied: false,
        expectedVersion: expectation.displayVersion,
        actualVersion: "1.0.0",
        mismatches: [mismatch],
        remediation: {
          type: "ReloadUnpackedExtension",
          extensionId: expectation.extensionId,
          directory: extensionDirectory,
        },
      });
    }
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
