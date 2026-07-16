import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { PairingCoordinator } from "../../src/core/pairing.js";
import type { PublicConnector, WebRunLeaseClaim, WebRunOffer } from "../../src/protocol/schema.js";

const begin = (pairing: PairingCoordinator) =>
  pairing.begin({
    expectedExtensionId: "extension-id",
    expectedExtensionDisplayVersion: "1.0.0",
    expectedProtocolFingerprint: "a".repeat(64),
  });

it.effect("issues a 128-bit one-shot capability", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const state = yield* begin(pairing);
    expect(state.type).toBe("pending");
    expect(state.challenge).toMatch(/^[0-9A-F]{32}$/);

    expect(
      yield* pairing.confirmAuthenticated(
        undefined,
        (challenge) => challenge === state.challenge,
        () => Effect.succeed("paired"),
      ),
    ).toBe("paired");
    expect(
      (yield* Effect.exit(
        pairing.confirmAuthenticated(
          undefined,
          (challenge) => challenge === state.challenge,
          () => Effect.void,
        ),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("invalidates capabilities on cancel and expiry", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const cancelled = yield* begin(pairing);
    yield* pairing.cancel;
    expect(
      (yield* Effect.exit(
        pairing.confirmAuthenticated(
          undefined,
          (challenge) => challenge === cancelled.challenge,
          () => Effect.void,
        ),
      ))._tag,
    ).toBe("Failure");

    const expired = yield* begin(pairing);
    yield* TestClock.adjust("2 minutes");
    expect(
      (yield* Effect.exit(
        pairing.confirmAuthenticated(
          undefined,
          (challenge) => challenge === expired.challenge,
          () => Effect.void,
        ),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("consumes the capability before running the pairing transition", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const state = yield* begin(pairing);

    expect(
      (yield* Effect.exit(
        pairing.confirmAuthenticated(
          undefined,
          (challenge) => challenge === state.challenge,
          () => Effect.fail("persistence failed"),
        ),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(
        pairing.confirmAuthenticated(
          undefined,
          (challenge) => challenge === state.challenge,
          () => Effect.void,
        ),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("linearizes concurrent confirmations around one capability", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const state = yield* begin(pairing);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const first = yield* Effect.forkChild(
      pairing.confirmAuthenticated(
        undefined,
        (challenge) => challenge === state.challenge,
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return "paired";
          }),
      ),
    );
    yield* Deferred.await(entered);
    const secondCompleted = yield* Deferred.make<void>();
    const second = yield* Effect.forkChild(
      pairing
        .confirmAuthenticated(
          undefined,
          (challenge) => challenge === state.challenge,
          () => Effect.void,
        )
        .pipe(Effect.ensuring(Deferred.succeed(secondCompleted, undefined))),
    );
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(secondCompleted))).toBe(true);

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBe("paired");
    expect((yield* Fiber.join(second).pipe(Effect.flip))._tag).toBe("PairingUnavailable");
  }),
);

const webConnector = (connectorId: string, label: string): PublicConnector => ({
  connectorId,
  label,
  extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
});

const webPairing = (
  pairingId: string,
  capability: string,
  connector: PublicConnector,
): { offer: WebRunOffer; claim: WebRunLeaseClaim } => ({
  offer: { version: 1, pairingId, capability, expiresAt: 120_000, connector },
  claim: {
    pairingId,
    leaseToken: capability.toLowerCase().repeat(2),
    connectorId: connector.connectorId,
    sessionKey: `session:${pairingId}`,
  },
});

it.effect("keeps concurrent web offers independent and binds proof to pairing id", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const first = webPairing(
      "11111111-1111-4111-8111-111111111111",
      "A".repeat(32),
      webConnector("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Personal"),
    );
    const second = webPairing(
      "22222222-2222-4222-8222-222222222222",
      "B".repeat(32),
      webConnector("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Work"),
    );
    yield* pairing.stageWeb(first.offer, first.claim);
    yield* pairing.stageWeb(second.offer, second.claim);

    expect(yield* pairing.prove(first.offer.pairingId, (challenge) => challenge)).toBe(
      first.offer.capability,
    );
    expect(yield* pairing.prove(second.offer.pairingId, (challenge) => challenge)).toBe(
      second.offer.capability,
    );
    expect(
      (yield* pairing
        .confirmAuthenticated(
          second.offer.pairingId,
          (challenge) => challenge === first.offer.capability,
          () => Effect.void,
        )
        .pipe(Effect.flip))._tag,
    ).toBe("PairingUnavailable");

    const confirmedFirst = yield* pairing.confirmAuthenticated(
      first.offer.pairingId,
      (challenge) => challenge === first.offer.capability,
      (web) => Effect.succeed(web?.claim),
    );
    expect(confirmedFirst).toEqual(first.claim);
    expect(yield* pairing.prove(second.offer.pairingId, (challenge) => challenge)).toBe(
      second.offer.capability,
    );
  }),
);

it.effect("rejects pairing id reuse with a different lease owner", () =>
  Effect.gen(function* () {
    const pairing = yield* PairingCoordinator.make;
    const first = webPairing(
      "11111111-1111-4111-8111-111111111111",
      "A".repeat(32),
      webConnector("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Personal"),
    );
    yield* pairing.stageWeb(first.offer, first.claim);
    const tampered = {
      ...first.claim,
      sessionKey: "session:attacker",
    } satisfies WebRunLeaseClaim;
    expect((yield* pairing.stageWeb(first.offer, tampered).pipe(Effect.flip))._tag).toBe(
      "PairingUnavailable",
    );
  }),
);
