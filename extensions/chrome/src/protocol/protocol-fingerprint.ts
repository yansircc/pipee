import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { BROWSER_COMPANION_CONTRACT } from "@pipee/companion-contracts/browser-companion";
import bridge from "./bridge.json" with { type: "json" };
import connectorAuthentication from "./connector-auth.json" with { type: "json" };
import { authenticationMessageProtocolContract } from "./bridge-authentication.js";
import { EVALUATION_VALUE_CONTRACT } from "./evaluation-value-contract.js";
import { operationResultProtocolContract } from "./operation-contract.js";
import { toJsonSchema, WireProtocolContract } from "./schema.js";

export class ProtocolFingerprintFailure extends Data.TaggedError("ProtocolFingerprintFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const JSON_SCHEMA_ANNOTATIONS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
const JSON_SCHEMA_MAPS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const JSON_SCHEMA_MEMBERS = new Set([
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const JSON_SCHEMA_SET_ARRAYS = new Set(["allOf", "anyOf", "enum", "oneOf", "required", "type"]);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  );
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const semanticJsonSchema = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, member]) => {
      if (JSON_SCHEMA_ANNOTATIONS.has(key)) return [];
      if (JSON_SCHEMA_MAPS.has(key) && typeof member === "object" && member !== null) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(member as Record<string, unknown>).map(([name, child]) => [
                name,
                semanticJsonSchema(child),
              ]),
            ),
          ],
        ];
      }
      if (JSON_SCHEMA_MEMBERS.has(key)) return [[key, semanticJsonSchema(member)]];
      if (key === "prefixItems" && Array.isArray(member)) {
        return [[key, member.map(semanticJsonSchema)]];
      }
      if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(member)) {
        const normalized = member.map(semanticJsonSchema);
        return [
          [
            key,
            normalized.sort((left, right) =>
              canonicalJson(left).localeCompare(canonicalJson(right)),
            ),
          ],
        ];
      }
      if (JSON_SCHEMA_SET_ARRAYS.has(key) && Array.isArray(member)) {
        const normalized = member.map(canonicalize);
        return [
          [
            key,
            normalized.sort((left, right) =>
              canonicalJson(left).localeCompare(canonicalJson(right)),
            ),
          ],
        ];
      }
      return [[key, canonicalize(member)]];
    }),
  );
};

const operationResultSemantics = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([domain, operations]) => [
      domain,
      typeof operations !== "object" || operations === null || Array.isArray(operations)
        ? operations
        : Object.fromEntries(
            Object.entries(operations).map(([operation, contract]) => {
              if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
                return [operation, contract];
              }
              const projected = contract as Record<string, unknown>;
              if (projected.mode === "schema") {
                return [operation, { ...projected, schema: semanticJsonSchema(projected.schema) }];
              }
              if (projected.mode === "by-call-fields") {
                const variants = projected.variants as Record<string, Record<string, unknown>>;
                return [
                  operation,
                  {
                    ...projected,
                    variants: Object.fromEntries(
                      Object.entries(variants).map(([capture, formats]) => [
                        capture,
                        Object.fromEntries(
                          Object.entries(formats).map(([format, schema]) => [
                            format,
                            semanticJsonSchema(schema),
                          ]),
                        ),
                      ]),
                    ),
                  },
                ];
              }
              return [operation, projected];
            }),
          ),
    ]),
  );
};

const semanticProtocolProjection = (contract: unknown): unknown => {
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) return contract;
  const value = contract as Record<string, unknown>;
  return {
    ...value,
    ...(Object.hasOwn(value, "wire") ? { wire: semanticJsonSchema(value.wire) } : {}),
    ...(Object.hasOwn(value, "operationResults")
      ? { operationResults: operationResultSemantics(value.operationResults) }
      : {}),
  };
};

export const canonicalProtocolContractFor = (
  contract: unknown,
): Effect.Effect<string, ProtocolFingerprintFailure> =>
  Effect.gen(function* () {
    const canonical = yield* Effect.try({
      try: () => JSON.stringify(canonicalize(semanticProtocolProjection(contract))),
      catch: (cause) =>
        new ProtocolFingerprintFailure({
          message: "Protocol contract cannot be serialized canonically",
          cause,
        }),
    });
    if (canonical === undefined) {
      return yield* new ProtocolFingerprintFailure({
        message: "Protocol contract did not produce canonical JSON",
      });
    }
    return canonical;
  });

const fingerprintCanonicalProtocolContract = (
  canonical: string,
): Effect.Effect<string, ProtocolFingerprintFailure> =>
  Effect.gen(function* () {
    const digest = yield* Effect.tryPromise({
      try: () => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
      catch: (cause) =>
        new ProtocolFingerprintFailure({
          message: "Protocol contract fingerprint could not be computed",
          cause,
        }),
    });
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

export const fingerprintProtocolContract = (
  contract: unknown,
): Effect.Effect<string, ProtocolFingerprintFailure> =>
  canonicalProtocolContractFor(contract).pipe(Effect.flatMap(fingerprintCanonicalProtocolContract));

export const canonicalProtocolContract: Effect.Effect<string, ProtocolFingerprintFailure> =
  Effect.try({
    try: () => ({
      wire: toJsonSchema(WireProtocolContract),
      operationResults: operationResultProtocolContract,
      evaluationValues: EVALUATION_VALUE_CONTRACT,
      authenticationMessages: authenticationMessageProtocolContract,
      browserCompanion: BROWSER_COMPANION_CONTRACT,
      bridge,
      connectorAuthentication,
    }),
    catch: (cause) =>
      new ProtocolFingerprintFailure({
        message: "Wire protocol contract could not be projected",
        cause,
      }),
  }).pipe(Effect.flatMap(canonicalProtocolContractFor));

export const protocolFingerprint: Effect.Effect<string, ProtocolFingerprintFailure> =
  canonicalProtocolContract.pipe(Effect.flatMap(fingerprintCanonicalProtocolContract));
