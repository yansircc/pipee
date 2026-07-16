import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { decodeHex, encodeHex } from "../protocol/bridge-authentication.js";
import { HMAC_AUTHENTICATION } from "../protocol/bridge-contract.js";

class BrowserBridgeAuthenticationFailure extends Data.TaggedError(
  "BrowserBridgeAuthenticationFailure",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const failure = (message: string, cause?: unknown) =>
  new BrowserBridgeAuthenticationFailure({ message, cause });

const WEB_CRYPTO_DIGEST = {
  sha256: "SHA-256",
} as const;

const webCryptoDigest =
  WEB_CRYPTO_DIGEST[HMAC_AUTHENTICATION.digest as keyof typeof WEB_CRYPTO_DIGEST];

const authenticationKey = (secret: string) => {
  if (HMAC_AUTHENTICATION.keyEncoding !== "hex") {
    return Effect.fail(failure("Bridge HMAC key encoding is unsupported"));
  }
  const bytes = decodeHex(secret);
  if (!bytes) return Effect.fail(failure("Bridge HMAC key is malformed"));
  if (!webCryptoDigest) return Effect.fail(failure("Bridge HMAC digest is unsupported"));
  const keyBytes = new Uint8Array(bytes.byteLength);
  keyBytes.set(bytes);
  return Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: webCryptoDigest },
        false,
        ["sign"],
      ),
    catch: (cause) => failure("Could not import the bridge HMAC key", cause),
  });
};

export const freshBridgeClientNonce = (): string =>
  encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

export const hashBrowserRequestBody = (body: string) =>
  webCryptoDigest
    ? Effect.tryPromise({
        try: () => globalThis.crypto.subtle.digest(webCryptoDigest, new TextEncoder().encode(body)),
        catch: (cause) => failure("Could not hash the bridge request body", cause),
      }).pipe(Effect.map(encodeHex))
    : Effect.fail(failure("Bridge HMAC digest is unsupported"));

export const browserHmacProof = (secret: string, message: string) =>
  Effect.gen(function* () {
    const key = yield* authenticationKey(secret);
    const signature = yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
      catch: (cause) => failure("Could not sign the bridge authentication proof", cause),
    });
    return encodeHex(signature);
  });

export const hasValidBrowserHmacProof = (secret: string, message: string, actual: string) =>
  browserHmacProof(secret, message).pipe(
    Effect.map((expected) => {
      if (actual.length !== expected.length) return false;
      let difference = 0;
      for (let index = 0; index < expected.length; index += 1) {
        difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
      }
      return difference === 0;
    }),
  );
