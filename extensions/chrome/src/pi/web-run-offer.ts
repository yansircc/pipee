import * as Effect from "effect/Effect";
import { AuthorizationFailure } from "../core/errors.js";
import { decodeWebRunOfferJson } from "../protocol/codec.js";
import type { WebRunOffer } from "../protocol/schema.js";

const MAX_WEB_RUN_OFFER_TOKEN_LENGTH = 4_096;

export const decodeWebRunOfferToken = (
  token: string,
): Effect.Effect<WebRunOffer, AuthorizationFailure> => {
  if (
    token.length === 0 ||
    token.length > MAX_WEB_RUN_OFFER_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    return Effect.fail(new AuthorizationFailure({ message: "Web run offer token is malformed" }));
  }
  return Effect.try({
    try: () => Buffer.from(token, "base64url").toString("utf8"),
    catch: () => new AuthorizationFailure({ message: "Web run offer token is malformed" }),
  }).pipe(
    Effect.flatMap(decodeWebRunOfferJson),
    Effect.mapError((error) =>
      error instanceof AuthorizationFailure
        ? error
        : new AuthorizationFailure({ message: "Web run offer payload is invalid" }),
    ),
  );
};
