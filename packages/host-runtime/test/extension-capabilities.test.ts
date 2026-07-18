import { describe, expect, it } from "@effect/vitest";
import {
  RUNTIME_RETENTION_CAPABILITY,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type RuntimeRetentionPort,
} from "@pi-suite/companion-contracts/host-capabilities";
import type {
  CandidateHash,
  WebSurfaceProjection,
  WebSurfaceRuntimePort,
} from "@pi-suite/companion-contracts/web-surface";
import { Effect, Fiber } from "effect";
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

  it.effect("owns one cancellable web surface controller per admitted package", () =>
    Effect.gen(function* () {
      const hash = "a".repeat(64) as CandidateHash;
      const projections: Array<WebSurfaceProjection | undefined> = [];
      let finish: ((value: { _tag: "Accepted"; payload: number }) => void) | undefined;
      const capabilities = makeExtensionHostCapabilities({
        replaceStructuredView: () => undefined,
        replaceMediaView: () => undefined,
        webSurfaceCandidates: new Map([["@fixture/surface", hash]]),
        replaceWebSurface: (_ownerId, projection) => projections.push(projection),
      });
      const port = capabilities.providers
        .get(WEB_SURFACE_RUNTIME_CAPABILITY)!
        .forExtension("@fixture/surface") as WebSurfaceRuntimePort;
      const handle = port.register({
        dispatch: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
      expect(() =>
        port.register({ dispatch: () => ({ _tag: "Accepted", payload: null }) }),
      ).toThrow();
      handle.replace({ answer: 41 });
      expect(projections.at(-1)).toMatchObject({ revision: 2, view: { answer: 41 } });
      const active = yield* capabilities
        .dispatchWebSurface("@fixture/surface", hash, { requestId: "one", payload: 41 })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(
        yield* capabilities.dispatchWebSurface("@fixture/surface", hash, {
          requestId: "two",
          payload: 1,
        }),
      ).toEqual({ _tag: "Rejected", reason: "busy" });
      finish?.({ _tag: "Accepted", payload: 42 });
      expect(yield* Fiber.join(active)).toEqual({ _tag: "Accepted", payload: 42 });
      handle.release();
      handle.release();
      expect(projections.at(-1)).toBeUndefined();
      expect(
        yield* capabilities.dispatchWebSurface("@fixture/surface", hash, {
          requestId: "three",
          payload: 1,
        }),
      ).toEqual({ _tag: "Rejected", reason: "closed" });
    }),
  );
});
