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

const pairInput = {
  endpoint: "http://example.test",
  intentId: "intent-1",
  code: "pairing-code",
  state: "state-1",
  redirectUri: "http://127.0.0.1:30141/zeroy/connect/callback",
  label: "A",
};

const stubExchangeFetch = (
  grant: Record<string, unknown>,
  calls?: Array<{ url: string }>,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/connection/exchange")) {
      return new Response(JSON.stringify(grant), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/connection/grants/")) {
      calls?.push({ url });
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

const siteId = "0ba8bf56-1e2c-4e83-b629-0f9abd21cbac";
const otherSiteId = "11111111-2222-3333-4444-555555555555";

describe("zeroY connection registry", () => {
  it("upserts a connection, projects read-only rows, and revokes without exposing secrets", async () => {
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

    await registry.provider.forExtension("alpha").revoke(siteId);
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

  it("stores the WordPress-issued grant secret, not the pairing code", async () => {
    const restore = stubExchangeFetch({ grantId: "g-1", siteId, grantSecret: "wp-issued-secret" });
    try {
      const registry = makeZeroYConnectionRegistry();
      await Effect.runPromise(registry.pairWithCode(pairInput));
      expect(registry.rows()).toHaveLength(1);
      expect(
        registry.provider.forExtension("alpha").readSecret(registry.rows()[0]!.credentialRef),
      ).toBe("wp-issued-secret");
    } finally {
      restore();
    }
  });

  it("a persistence failure fails the pairing instead of reporting success", async () => {
    const restore = stubExchangeFetch({ grantId: "g-2", siteId, grantSecret: "s2" });
    try {
      const registry = makeZeroYConnectionRegistry({
        persist: () => Effect.fail(new Error("disk full")),
      });
      const failure = await Effect.runPromise(
        registry.pairWithCode(pairInput).pipe(Effect.flip, Effect.option),
      );
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ZeroYConnectionRegistryError);
        expect(failure.value.message).toContain("disk full");
      }
    } finally {
      restore();
    }
  });

  it("an exchange response without a grant secret is rejected", async () => {
    const restore = stubExchangeFetch({ grantId: "g-3", siteId });
    try {
      const registry = makeZeroYConnectionRegistry();
      const failure = await Effect.runPromise(
        registry.pairWithCode(pairInput).pipe(Effect.flip, Effect.option),
      );
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value.message).toContain("no grant secret");
      }
    } finally {
      restore();
    }
  });

  it("a failed persist leaves rows, secrets and projections unchanged and does not notify", async () => {
    const restore = stubExchangeFetch({ grantId: "g-5", siteId, grantSecret: "s5" });
    try {
      const registry = makeZeroYConnectionRegistry({
        persist: () => Effect.fail(new Error("disk full")),
      });
      let notified = 0;
      const unsubscribe = registry.provider
        .forExtension("alpha")
        .subscribe(() => {
          notified += 1;
        });
      const failure = await Effect.runPromise(
        registry.pairWithCode(pairInput).pipe(Effect.flip, Effect.option),
      );
      expect(failure._tag).toBe("Some");
      // public state untouched: no rows, no secrets, no projection, no notify
      expect(registry.rows()).toHaveLength(0);
      expect(registry.provider.forExtension("alpha").list().sites).toHaveLength(0);
      expect(() => registry.provider.forExtension("alpha").readSecret("anything")).toThrowError(
        ZeroYConnectionRegistryError,
      );
      expect(notified).toBe(0);
      unsubscribe();
    } finally {
      restore();
    }
  });

  it("a failed persist does not revoke the superseded grant (revoke runs only after commit)", async () => {
    const calls: Array<{ url: string }> = [];
    const restore = stubExchangeFetch({ grantId: "g-6", siteId, grantSecret: "s6" }, calls);
    let failPersist = false;
    try {
      const registry = makeZeroYConnectionRegistry({
        persist: () => (failPersist ? Effect.fail(new Error("disk full")) : Effect.void),
      });
      await Effect.runPromise(registry.pairWithCode(pairInput));
      expect(registry.rows()).toHaveLength(1);
      const firstSecret = registry.provider.forExtension("alpha").readSecret(registry.rows()[0]!.credentialRef);
      expect(firstSecret).toBe("s6");
      // second pairing: persist fails -> the first grant must NOT be revoked
      failPersist = true;
      const failure = await Effect.runPromise(
        registry
          .pairWithCode({ ...pairInput, intentId: "intent-2", code: "pairing-code-2" })
          .pipe(Effect.flip, Effect.option),
      );
      expect(failure._tag).toBe("Some");
      expect(calls).toHaveLength(0); // no remote revoke happened
      expect(registry.rows()).toHaveLength(1); // old state intact
      expect(
        registry.provider.forExtension("alpha").readSecret(registry.rows()[0]!.credentialRef),
      ).toBe("s6");
    } finally {
      restore();
    }
  });

  it("restores a persisted snapshot (rows + secrets in one generation) after a restart", async () => {
    const directory = join(tmpdir(), `zeroy-registry-secrets-${randomUUID()}`);
    const restore = stubExchangeFetch({ grantId: "g-r", siteId, grantSecret: "persisted-secret" });
    try {
      const first = makeZeroYConnectionRegistry({
        persist: (snapshot) =>
          first.persist(directory, snapshot).pipe(Effect.provide(nodeServices)),
      });
      await Effect.runPromise(first.pairWithCode(pairInput));
      first.dispose();

      const second = makeZeroYConnectionRegistry();
      await Effect.runPromise(second.load(directory).pipe(Effect.provide(nodeServices)));
      expect(second.rows()).toHaveLength(1);
      expect(
        second.provider.forExtension("alpha").readSecret(second.rows()[0]!.credentialRef),
      ).toBe("persisted-secret");
      second.dispose();
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
