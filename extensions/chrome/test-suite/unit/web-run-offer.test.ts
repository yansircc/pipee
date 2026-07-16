import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WebRunOfferFailure, WebRunOfferOwner } from "../../src/browser/web-run-offer.js";

const connector = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  secret: "a".repeat(64),
  label: "Work profile",
  extensionId: "b".repeat(32),
  extensionDisplayVersion: "0.5.7",
  protocolFingerprint: "c".repeat(64),
};

it.effect("binds prepare and complete to the exact Pi Web origin", () =>
  Effect.gen(function* () {
    let record: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: async (key: string) => ({ [key]: record[key] }),
          set: async (next: Record<string, unknown>) => {
            record = { ...record, ...next };
          },
          remove: async (key: string) => {
            const next = { ...record };
            delete next[key];
            record = next;
          },
        },
      },
    });
    const owner = WebRunOfferOwner.makeUnsafe();
    const prepared = yield* owner.prepare(connector, "http://127.0.0.1:41001");

    const failure = yield* owner
      .complete(prepared.pairingId, connector, "http://127.0.0.1:41002")
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(WebRunOfferFailure);
    expect(failure.message).toContain("another Pi Web origin");
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))),
);
