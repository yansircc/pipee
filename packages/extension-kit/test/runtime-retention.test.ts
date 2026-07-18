import { expect, it } from "@effect/vitest";
import {
  RUNTIME_RETENTION_CAPABILITY,
  type RuntimeRetentionPort,
} from "@pi-suite/companion-contracts/host-capabilities";
import { Effect } from "effect";
import {
  makeRuntimeRetentionSlot,
  structuredView,
  type HostCapabilityCarrier,
  type RuntimeRetentionSlot,
} from "../src/index.js";

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
