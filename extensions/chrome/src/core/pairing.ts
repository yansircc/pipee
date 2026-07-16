import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_PENDING_WEB_RUN_OFFERS,
  WEB_RUN_OFFER_LIFETIME_MS,
} from "../protocol/bridge-contract.js";
import type {
  PairingExpectation,
  PairingState,
  WebRunLeaseClaim,
  WebRunOffer,
} from "../protocol/schema.js";
import { PairingUnavailable } from "./errors.js";

const TERMINAL_PAIRING = "terminal";

type WebPairing = {
  readonly offer: WebRunOffer;
  readonly claim: WebRunLeaseClaim;
};

type PendingPairing = {
  readonly challenge: string;
  readonly expiresAt: number;
  readonly web?: WebPairing;
};

const pairingKey = (pairingId: string | undefined): string => pairingId ?? TERMINAL_PAIRING;

const sameWebPairing = (left: WebPairing, right: WebPairing): boolean =>
  left.offer.pairingId === right.offer.pairingId &&
  left.offer.capability === right.offer.capability &&
  left.offer.expiresAt === right.offer.expiresAt &&
  left.offer.connector.connectorId === right.offer.connector.connectorId &&
  left.claim.leaseToken === right.claim.leaseToken &&
  left.claim.sessionKey === right.claim.sessionKey;

export class PairingCoordinator {
  private constructor(
    private readonly pending: Ref.Ref<ReadonlyMap<string, PendingPairing>>,
    private readonly lock: Semaphore.Semaphore,
  ) {}

  static make = Effect.all({
    pending: Ref.make<ReadonlyMap<string, PendingPairing>>(new Map()),
    lock: Semaphore.make(1),
  }).pipe(Effect.map(({ pending, lock }) => new PairingCoordinator(pending, lock)));

  begin(expectation: PairingExpectation): Effect.Effect<PairingState> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis;
        const pairing = {
          challenge: makeCapability(),
          expiresAt: now + WEB_RUN_OFFER_LIFETIME_MS,
        };
        yield* Ref.update(this.pending, (pending) =>
          new Map(pending).set(TERMINAL_PAIRING, pairing),
        );
        return {
          type: "pending",
          ...pairing,
          ...expectation,
        } as const;
      }),
    );
  }

  stageWeb(offer: WebRunOffer, claim: WebRunLeaseClaim): Effect.Effect<void, PairingUnavailable> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis;
        if (
          offer.expiresAt <= now ||
          offer.expiresAt > now + WEB_RUN_OFFER_LIFETIME_MS ||
          claim.pairingId !== offer.pairingId ||
          claim.connectorId !== offer.connector.connectorId
        ) {
          return yield* new PairingUnavailable({ message: "Web run offer is invalid or expired" });
        }
        const pending = yield* Ref.get(this.pending);
        const existing = pending.get(offer.pairingId);
        const web = { offer, claim } satisfies WebPairing;
        if (existing?.web) {
          if (sameWebPairing(existing.web, web)) return;
          return yield* new PairingUnavailable({
            message: `Web pairing ${offer.pairingId} is already owned by another lease`,
          });
        }
        const webPairingCount = [...pending.values()].filter(
          (entry) => entry.web !== undefined,
        ).length;
        if (webPairingCount >= MAX_PENDING_WEB_RUN_OFFERS) {
          return yield* new PairingUnavailable({ message: "Too many pending web run offers" });
        }
        yield* Ref.set(
          this.pending,
          new Map(pending).set(offer.pairingId, {
            challenge: offer.capability,
            expiresAt: offer.expiresAt,
            web,
          }),
        );
      }),
    );
  }

  get cancel(): Effect.Effect<void> {
    return this.lock.withPermits(1)(
      Ref.update(this.pending, (pending) => {
        const next = new Map(pending);
        next.delete(TERMINAL_PAIRING);
        return next;
      }),
    );
  }

  cancelWeb(claim: WebRunLeaseClaim): Effect.Effect<void, PairingUnavailable> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const pending = yield* Ref.get(this.pending);
        const existing = pending.get(claim.pairingId);
        if (!existing) return;
        if (!existing.web || !sameWebPairing(existing.web, { offer: existing.web.offer, claim })) {
          return yield* new PairingUnavailable({
            message: `Web pairing ${claim.pairingId} is owned by another lease`,
          });
        }
        const next = new Map(pending);
        next.delete(claim.pairingId);
        yield* Ref.set(this.pending, next);
      }),
    );
  }

  prove<A>(
    pairingId: string | undefined,
    proof: (challenge: string) => A,
  ): Effect.Effect<A, PairingUnavailable> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const pending = yield* this.requirePending(pairingId);
        return proof(pending.challenge);
      }),
    );
  }

  confirmAuthenticated<A, E, R>(
    pairingId: string | undefined,
    authenticate: (challenge: string) => boolean,
    transition: (web: WebPairing | undefined) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PairingUnavailable, R> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const pending = yield* this.requirePending(pairingId);
        if (!authenticate(pending.challenge)) {
          return yield* new PairingUnavailable({ message: "Pairing authentication failed" });
        }
        yield* Ref.update(this.pending, (entries) => {
          const next = new Map(entries);
          next.delete(pairingKey(pairingId));
          return next;
        });
        return yield* transition(pending.web);
      }),
    );
  }

  private requirePending(
    pairingId: string | undefined,
  ): Effect.Effect<PendingPairing, PairingUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      const pending = (yield* Ref.get(this.pending)).get(pairingKey(pairingId));
      if (!pending || pending.expiresAt <= now) {
        return yield* new PairingUnavailable({
          message: "Pairing challenge is missing or expired",
        });
      }
      return pending;
    });
  }
}

const makeCapability = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};
