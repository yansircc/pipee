import { describe, expect, it } from "vite-plus/test";
import {
  projectCompanionReadiness,
  type ChromeStatusProjection,
} from "../../src/protocol/chrome.js";
import type { BrowserCompanionExpectation } from "@pipee/companion-contracts/browser-companion";

const expected: BrowserCompanionExpectation = {
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  displayVersion: "1.2.3",
  protocolFingerprint: "f".repeat(64),
};

const status = (
  state: ChromeStatusProjection["state"],
  overrides: Partial<ChromeStatusProjection> = {},
): ChromeStatusProjection => ({
  kind: "pi-chrome/status",
  version: 3,
  state,
  bridge: state === "error" ? "error" : "running",
  extensionDirectory: "/candidate/browser-extension",
  ...overrides,
});

const project = (overrides: Partial<Parameters<typeof projectCompanionReadiness>[0]> = {}) =>
  projectCompanionReadiness({
    expected,
    probe: { _tag: "Compatible", expected, actual: expected },
    status: status("waiting-for-extension"),
    startedAt: 1_000,
    now: 1_500,
    timeoutMs: 10_000,
    ...overrides,
  });

describe("CompanionReadiness", () => {
  it("projects PackageMissing before browser and runtime facts", () => {
    expect(project({ expected: null, probe: null, status: status("ready") })._tag).toBe(
      "PackageMissing",
    );
  });

  it("projects CompanionMissing until a browser-owned probe answers", () => {
    expect(project({ probe: null })._tag).toBe("CompanionMissing");
    expect(project({ probe: { _tag: "Missing", expected } })._tag).toBe("CompanionMissing");
  });

  it("projects CompanionIncompatible before connector state", () => {
    const actual = { ...expected, displayVersion: "1.2.2" };
    expect(
      project({
        probe: { _tag: "Incompatible", expected, actual, mismatches: ["DisplayVersion"] },
        status: status("ready", {
          connector: { id: "connector", label: "Chrome", connected: true },
        }),
      }),
    ).toMatchObject({ _tag: "CompanionIncompatible", mismatches: ["DisplayVersion"] });
  });

  it("projects Connecting only while the compatible connector is pending", () => {
    expect(project()).toEqual({ _tag: "Connecting", expected, startedAt: 1_000 });
  });

  it("projects Ready only for a connected connector", () => {
    expect(
      project({
        status: status("ready", {
          connector: {
            id: "connector",
            label: "Personal Chrome",
            connected: true,
            lastSeenAt: 1_400,
          },
        }),
      }),
    ).toMatchObject({ _tag: "Ready", connector: { id: "connector", label: "Personal Chrome" } });
    expect(
      project({
        status: status("ready", {
          connector: { id: "connector", label: "Personal Chrome", connected: false },
        }),
      })._tag,
    ).toBe("Connecting");
    expect(
      project({
        status: status("ready", {
          bridge: "stopped",
          connector: { id: "connector", label: "Personal Chrome", connected: true },
        }),
      })._tag,
    ).toBe("Connecting");
  });

  it("projects stable failure reasons after errors or the deadline", () => {
    expect(
      project({ status: status("error", { errorMessage: "bridge bind failed" }) }),
    ).toMatchObject({
      _tag: "ConnectionFailed",
      reason: "bridge-unavailable",
    });
    expect(
      project({ status: status("error", { errorMessage: "extension incompatible" }) }),
    ).toMatchObject({ _tag: "ConnectionFailed", reason: "protocol-mismatch" });
    expect(project({ status: status("offline"), now: 11_000 })).toMatchObject({
      _tag: "ConnectionFailed",
      reason: "profile-offline",
    });
    expect(project({ status: status("waiting-for-extension"), now: 11_000 })).toMatchObject({
      _tag: "ConnectionFailed",
      reason: "connector-timeout",
    });
  });
});
