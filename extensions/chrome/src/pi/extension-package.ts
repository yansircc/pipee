import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { createHash, createPublicKey } from "node:crypto";
import { EXTENSION_PUBLIC_KEY } from "../protocol/connector-auth.ts";

class ExtensionPublicKeyInvalid extends Data.TaggedError("ExtensionPublicKeyInvalid")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const effectRuntime = ManagedRuntime.make(Layer.empty);

const deriveExtensionPackageId = (encodedKey: string) =>
  Effect.gen(function* () {
    const publicKey = Buffer.from(encodedKey, "base64");
    const parsed = yield* Effect.try({
      try: () => createPublicKey({ key: publicKey, format: "der", type: "spki" }),
      catch: (cause) =>
        new ExtensionPublicKeyInvalid({
          message: "Chrome extension public key must be valid SPKI",
          cause,
        }),
    });
    if (parsed.asymmetricKeyType !== "rsa") {
      return yield* new ExtensionPublicKeyInvalid({
        message: "Chrome extension public key must be RSA",
      });
    }
    const alphabet = "abcdefghijklmnop";
    return [...createHash("sha256").update(publicKey).digest().subarray(0, 16)]
      .map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 0x0f]}`)
      .join("");
  });

export const extensionPackageIdFromPublicKey = (encodedKey: string): string =>
  effectRuntime.runSync(deriveExtensionPackageId(encodedKey));

export const EXTENSION_PACKAGE_ID = extensionPackageIdFromPublicKey(EXTENSION_PUBLIC_KEY);
