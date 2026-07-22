import { describe, expect, it } from "vite-plus/test";
import { chromeExtensionProbeRequest } from "../../src/protocol/chrome.js";
import { handleChromeExtensionProbe } from "../../src/browser/external-probe.js";

describe("external Chrome extension probe", () => {
  const runtime = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    getManifest: () => ({ version: "0.3.0" }),
  };

  it("returns browser-owned identity and build evidence", () => {
    expect(
      handleChromeExtensionProbe(chromeExtensionProbeRequest, runtime, "f".repeat(64)),
    ).toEqual({
      kind: "pipee/browser-companion-probe",
      version: 2,
      extension: {
        extensionId: runtime.id,
        displayVersion: "0.3.0",
        protocolFingerprint: "f".repeat(64),
      },
    });
  });

  it("ignores unrelated external messages", () => {
    expect(handleChromeExtensionProbe({ kind: "other" }, runtime, "f".repeat(64))).toBeUndefined();
  });

  it("rejects the retired companion probe identity", () => {
    const retiredKind = `${["pi", "suite"].join("-")}/browser-companion-probe`;
    expect(
      handleChromeExtensionProbe({ kind: retiredKind, version: 1 }, runtime, "f".repeat(64)),
    ).toBeUndefined();
  });

  it("rejects the previous Pipee probe version", () => {
    expect(
      handleChromeExtensionProbe(
        { ...chromeExtensionProbeRequest, version: 1 },
        runtime,
        "f".repeat(64),
      ),
    ).toBeUndefined();
  });
});
