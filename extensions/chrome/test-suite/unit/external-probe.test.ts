import { describe, expect, it } from "vite-plus/test";
import { chromeExtensionProbeRequest } from "@pipee/companion-contracts/chrome";
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
      kind: "pi-suite/browser-companion-probe",
      version: 1,
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
});
