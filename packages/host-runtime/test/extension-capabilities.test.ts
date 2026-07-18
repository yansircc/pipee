import { describe, expect, it } from "@effect/vitest";
import {
  RUNTIME_RETENTION_CAPABILITY,
  type RuntimeRetentionPort,
} from "@pi-suite/companion-contracts/host-capabilities";
import { makeExtensionHostCapabilities } from "../src/extension-capabilities.js";

describe("extension host capabilities", () => {
  it("binds owners and keeps stale handles from releasing replacement claims", () => {
    const capabilities = makeExtensionHostCapabilities({
      replaceStructuredView: () => undefined,
      replaceMediaView: () => undefined,
    });
    const provider = capabilities.providers.get(RUNTIME_RETENTION_CAPABILITY)!;
    const port = provider.forExtension("alpha") as RuntimeRetentionPort;
    const first = port.acquire("runtime", { reason: "first" });
    const second = port.acquire("runtime", { reason: "second" });

    first.release();
    expect(capabilities.hasRetention()).toBe(true);
    second.release();
    expect(capabilities.hasRetention()).toBe(false);
  });
});
