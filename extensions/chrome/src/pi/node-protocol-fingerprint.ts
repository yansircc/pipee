import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import {
  canonicalProtocolContract,
  ProtocolFingerprintFailure,
} from "../protocol/protocol-fingerprint.js";

export const nodeProtocolFingerprint: Effect.Effect<string, ProtocolFingerprintFailure> =
  canonicalProtocolContract.pipe(
    Effect.flatMap((canonical) =>
      Effect.try({
        try: () => createHash("sha256").update(canonical, "utf8").digest("hex"),
        catch: (cause) =>
          new ProtocolFingerprintFailure({
            message: "Node protocol contract fingerprint could not be computed",
            cause,
          }),
      }),
    ),
  );
