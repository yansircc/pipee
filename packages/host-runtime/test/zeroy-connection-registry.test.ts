import { describe, expect, it } from "@effect/vitest";
import { layer as nodeServices } from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InMemorySecretStorage,
  makeZeroYConnectionRegistry,
  ZeroYConnectionRegistryError,
} from "../src/zeroy-connection-registry.js";

const siteId = "0ba8bf56-1e2c-4e83-b629-0f9abd21cbac";
const otherSiteId = "11111111-2222-3333-4444-555555555555";

describe("zeroY connection registry", () => {
  it("upserts a connection, projects read-only rows, and revokes without exposing secrets", () => {
    const storage = new InMemorySecretStorage();
    const registry = makeZeroYConnectionRegistry({ secretStorage: storage });
    registry.upsert(
      {
        siteId,
        label: "Staging",
        endpoint: "http://localhost:10001",
        grantId: "grant-1",
      },
      "secret-plaintext",
    );

    const projected = registry.provider.forExtension("alpha").list();
    expect(projected.sites).toHaveLength(1);
    expect(projected.sites[0]!.label).toBe("Staging");
    expect(projected.sites[0]!.revoked).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("secret-plaintext");

    const secret = registry.provider
      .forExtension("alpha")
      .readSecret(registry.rows()[0]!.credentialRef);
    expect(secret).toBe("secret-plaintext");

    registry.provider.forExtension("alpha").revoke(siteId);
    expect(registry.rows()[0]!.revokedAt).not.toBeNull();
    expect(registry.provider.forExtension("alpha").list().sites[0]!.revoked).toBe(true);
    expect(() =>
      registry.provider.forExtension("alpha").readSecret(registry.rows()[0]!.credentialRef),
    ).toThrowError(ZeroYConnectionRegistryError);

    registry.dispose();
  });

  it("fires subscription listeners on mutation and stops after unsubscribe", () => {
    const registry = makeZeroYConnectionRegistry();
    let fired = 0;
    const unsubscribe = registry.provider.forExtension("alpha").subscribe(() => {
      fired += 1;
    });
    registry.upsert({ siteId, label: "A", endpoint: "http://example.test", grantId: "g1" }, "s1");
    expect(fired).toBe(1);
    unsubscribe();
    registry.upsert(
      { siteId: otherSiteId, label: "B", endpoint: "http://example2.test", grantId: "g2" },
      "s2",
    );
    expect(fired).toBe(1);
  });

  it("rejects invalid endpoints and removes the previous secret on re-upsert", () => {
    const storage = new InMemorySecretStorage();
    const registry = makeZeroYConnectionRegistry({ secretStorage: storage });
    expect(() =>
      registry.upsert({ siteId, label: "A", endpoint: "not-a-url", grantId: "g1" }, "s1"),
    ).toThrowError(ZeroYConnectionRegistryError);

    registry.upsert(
      { siteId, label: "A", endpoint: "http://example.test", grantId: "g1" },
      "first-secret",
    );
    const firstRef = registry.rows()[0]!.credentialRef;
    registry.upsert(
      { siteId, label: "A v2", endpoint: "http://example.test", grantId: "g1" },
      "second-secret",
    );
    expect(registry.rows()).toHaveLength(1);
    expect(storage.read(firstRef)).toBeUndefined();
    expect(storage.read(registry.rows()[0]!.credentialRef)).toBe("second-secret");
  });

  it("restores persisted grant secrets after a restart", async () => {
    const directory = join(tmpdir(), `zeroy-registry-secrets-${randomUUID()}`);
    try {
      const first = makeZeroYConnectionRegistry();
      first.upsert(
        { siteId, label: "Staging", endpoint: "http://example.test", grantId: "g1" },
        "persisted-secret",
      );
      await Effect.runPromise(first.persist(directory).pipe(Effect.provide(nodeServices)));
      first.dispose();

      const second = makeZeroYConnectionRegistry();
      await Effect.runPromise(second.load(directory).pipe(Effect.provide(nodeServices)));
      expect(second.rows()).toHaveLength(1);
      expect(
        second.provider.forExtension("alpha").readSecret(second.rows()[0]!.credentialRef),
      ).toBe("persisted-secret");
      second.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
