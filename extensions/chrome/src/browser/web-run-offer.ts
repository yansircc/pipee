import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_PENDING_WEB_RUN_OFFERS,
  WEB_RUN_OFFER_LIFETIME_MS,
} from "../protocol/bridge-contract.js";
import { decodePairingConfirmResponseJson } from "../protocol/codec.js";
import { WebRunOffer as WebRunOfferSchema } from "../protocol/schema.js";
import type { ProfileConnector, PublicConnector, WebRunOffer } from "../protocol/schema.js";
import { pairingRequest, requireConnectorSuccess } from "./connector-http.js";

const WEB_RUN_OFFERS_STORAGE_KEY = "piChromeWebRunOffers";

const StoredWebRunOffer = Schema.Struct({
  offer: WebRunOfferSchema,
  webOrigin: Schema.NonEmptyString,
});
type StoredWebRunOffer = typeof StoredWebRunOffer.Type;

export class WebRunOfferFailure extends Data.TaggedError("WebRunOfferFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const publicConnector = (connector: ProfileConnector): PublicConnector => ({
  connectorId: connector.connectorId,
  label: connector.label,
  extensionId: connector.extensionId,
  extensionDisplayVersion: connector.extensionDisplayVersion,
  protocolFingerprint: connector.protocolFingerprint,
});

const samePublicConnector = (left: PublicConnector, right: PublicConnector): boolean =>
  left.connectorId === right.connectorId &&
  left.label === right.label &&
  left.extensionId === right.extensionId &&
  left.extensionDisplayVersion === right.extensionDisplayVersion &&
  left.protocolFingerprint === right.protocolFingerprint;

const readOffers = Effect.tryPromise({
  try: () => chrome.storage.session.get(WEB_RUN_OFFERS_STORAGE_KEY),
  catch: (cause) =>
    new WebRunOfferFailure({ message: "Could not read pending web run offers", cause }),
}).pipe(
  Effect.flatMap((record) => {
    const stored = record[WEB_RUN_OFFERS_STORAGE_KEY];
    if (stored === undefined) return Effect.succeed(new Map<string, StoredWebRunOffer>());
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      return Effect.fail(new WebRunOfferFailure({ message: "Pending web run offers are invalid" }));
    }
    return Effect.forEach(Object.entries(stored), ([pairingId, value]) =>
      Schema.decodeUnknownEffect(StoredWebRunOffer, { onExcessProperty: "error" })(value).pipe(
        Effect.mapError(
          (cause) =>
            new WebRunOfferFailure({
              message: `Pending web run offer ${pairingId} is invalid`,
              cause,
            }),
        ),
        Effect.map((offer) => [pairingId, offer] as const),
      ),
    ).pipe(Effect.map((entries) => new Map(entries)));
  }),
);

const persistOffers = (offers: ReadonlyMap<string, StoredWebRunOffer>) =>
  Effect.tryPromise({
    try: () =>
      offers.size === 0
        ? chrome.storage.session.remove(WEB_RUN_OFFERS_STORAGE_KEY)
        : chrome.storage.session.set({
            [WEB_RUN_OFFERS_STORAGE_KEY]: Object.fromEntries(offers),
          }),
    catch: (cause) =>
      new WebRunOfferFailure({ message: "Could not persist pending web run offers", cause }),
  });

const pruneOffers = (offers: ReadonlyMap<string, StoredWebRunOffer>, now: number) =>
  new Map([...offers].filter(([, stored]) => stored.offer.expiresAt > now));

const makeCapability = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();

const encodeOffer = (offer: WebRunOffer): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(offer));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export type PreparedWebRunOffer = {
  readonly pairingId: string;
  readonly offer: string;
};

export class WebRunOfferOwner {
  private constructor(private readonly lock: Semaphore.Semaphore) {}

  static makeUnsafe = (): WebRunOfferOwner => new WebRunOfferOwner(Semaphore.makeUnsafe(1));

  prepare(
    connector: ProfileConnector,
    webOrigin: string,
  ): Effect.Effect<PreparedWebRunOffer, WebRunOfferFailure> {
    return this.lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const offers = pruneOffers(yield* readOffers, now);
        if (offers.size >= MAX_PENDING_WEB_RUN_OFFERS) {
          return yield* new WebRunOfferFailure({ message: "Too many pending web run offers" });
        }
        const pairingId = globalThis.crypto.randomUUID();
        const offer = {
          version: 1,
          pairingId,
          capability: makeCapability(),
          expiresAt: now + WEB_RUN_OFFER_LIFETIME_MS,
          connector: publicConnector(connector),
        } satisfies WebRunOffer;
        yield* persistOffers(new Map(offers).set(pairingId, { offer, webOrigin }));
        return { pairingId, offer: encodeOffer(offer) };
      }),
    );
  }

  complete(
    pairingId: string,
    connector: ProfileConnector,
    webOrigin: string,
  ): Effect.Effect<PublicConnector, WebRunOfferFailure> {
    return this.lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const offers = pruneOffers(yield* readOffers, now);
        const stored = offers.get(pairingId);
        if (!stored) {
          return yield* new WebRunOfferFailure({
            message: `Web run offer ${pairingId} is missing or expired`,
          });
        }
        if (stored.webOrigin !== webOrigin) {
          return yield* new WebRunOfferFailure({
            message: "Web run offer belongs to another Pi Web origin",
          });
        }
        const { offer } = stored;
        if (!samePublicConnector(offer.connector, publicConnector(connector))) {
          return yield* new WebRunOfferFailure({
            message: "Web run offer belongs to another Chrome profile connector",
          });
        }
        const response = yield* pairingRequest(
          {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connector }),
          },
          connector,
          offer.capability,
          pairingId,
        ).pipe(
          Effect.flatMap(requireConnectorSuccess),
          Effect.flatMap(decodePairingConfirmResponseJson),
          Effect.mapError(
            (cause) =>
              new WebRunOfferFailure({ message: "Could not confirm web run offer", cause }),
          ),
        );
        if (response.ok === false) {
          return yield* new WebRunOfferFailure({ message: response.error });
        }
        const remaining = new Map(offers);
        remaining.delete(pairingId);
        yield* persistOffers(remaining);
        return response.connector;
      }),
    );
  }
}
