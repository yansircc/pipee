import { expect, it } from "@effect/vitest";
import {
  RUNTIME_RETENTION_CAPABILITY,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type RuntimeRetentionPort,
} from "@pipee/companion-contracts/host-capabilities";
import { Effect } from "effect";
import {
  makeRuntimeRetentionSlot,
  structuredView,
  type HostCapabilityCarrier,
  type RuntimeRetentionSlot,
  webSurface,
  WebSurfaceCapabilityUnavailable,
} from "../src/index.js";
import type { WebSurfaceRuntimePort } from "@pipee/companion-contracts/web-surface";

it("returns undefined when the host does not provide Suite capabilities", () => {
  expect(structuredView({}, "alpha")).toBeUndefined();
});

it.effect("releases the current runtime claim when its Effect scope closes", () =>
  Effect.gen(function* () {
    let retained = false;
    let slot: RuntimeRetentionSlot | undefined;
    const port: RuntimeRetentionPort = {
      acquire: () => {
        retained = true;
        return { release: () => (retained = false) };
      },
    };
    const host: HostCapabilityCarrier = {
      getPiSuiteCapability: <T>(_ownerId: string, id: string) =>
        (id === RUNTIME_RETENTION_CAPABILITY ? port : undefined) as T | undefined,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const active = yield* makeRuntimeRetentionSlot(host, "alpha", "runtime");
        slot = active;
        yield* Effect.sync(() => active.replace({ reason: "running" }));
        expect(retained).toBe(true);
      }),
    );
    expect(retained).toBe(false);
    slot!.replace({ reason: "stale" });
    expect(retained).toBe(false);
  }),
);

it.effect("fails closed without a web surface port and releases the registration with Scope", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.scoped(
      webSurface({}, "alpha", () => ({ _tag: "Accepted", payload: null })),
    ).pipe(Effect.flip);
    expect(missing).toBeInstanceOf(WebSurfaceCapabilityUnavailable);
    let releases = 0;
    const port: WebSurfaceRuntimePort = {
      register: () => ({
        replace: () => undefined,
        release: () => {
          releases += 1;
        },
      }),
    };
    const host: HostCapabilityCarrier = {
      getPiSuiteCapability: <T>(_ownerId: string, id: string) =>
        (id === WEB_SURFACE_RUNTIME_CAPABILITY ? port : undefined) as T | undefined,
    };
    yield* Effect.scoped(webSurface(host, "alpha", () => ({ _tag: "Accepted", payload: null })));
    expect(releases).toBe(1);
  }),
);
