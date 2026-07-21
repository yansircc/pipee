import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodeProtocolFingerprint } from "../../src/pi/node-protocol-fingerprint.js";
import { EVALUATION_VALUE_CONTRACT } from "../../src/protocol/evaluation-value-contract.js";
import {
  canonicalProtocolContract,
  canonicalProtocolContractFor,
  fingerprintProtocolContract,
  protocolFingerprint,
} from "../../src/protocol/protocol-fingerprint.js";

type JsonPath = ReadonlyArray<string | number>;

const leafPaths = (value: unknown, prefix: JsonPath = []): ReadonlyArray<JsonPath> => {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...prefix, index]));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...prefix, key]));
  return [prefix];
};

const mutateLeaf = (root: unknown, path: JsonPath): unknown => {
  const mutated = structuredClone(root) as Record<string | number, unknown>;
  let parent = mutated;
  for (const segment of path.slice(0, -1)) {
    parent = parent[segment] as Record<string | number, unknown>;
  }
  const key = path.at(-1)!;
  const value = parent[key];
  parent[key] = typeof value === "number" ? value + 1 : `${String(value)}-mutated`;
  return mutated;
};

it.effect("derives one deterministic lowercase SHA-256 protocol fingerprint", () =>
  Effect.gen(function* () {
    const browserFingerprint = yield* protocolFingerprint;
    const repeated = yield* protocolFingerprint;
    const nodeFingerprint = yield* nodeProtocolFingerprint;

    expect(browserFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated).toBe(browserFingerprint);
    expect(nodeFingerprint).toBe(browserFingerprint);
  }),
);

it.effect("canonicalizes object keys without erasing contract changes", () =>
  Effect.gen(function* () {
    const left = { envelope: { command: "string", id: "string" }, revision: 1 };
    const reordered = { revision: 1, envelope: { id: "string", command: "string" } };
    const changed = { revision: 1, envelope: { id: "string", command: "number" } };

    expect(yield* canonicalProtocolContractFor(left)).toBe(
      yield* canonicalProtocolContractFor(reordered),
    );
    expect(yield* fingerprintProtocolContract(left)).toBe(
      yield* fingerprintProtocolContract(reordered),
    );
    expect(yield* fingerprintProtocolContract(changed)).not.toBe(
      yield* fingerprintProtocolContract(left),
    );
  }),
);

it.effect("ignores JSON Schema annotations and set ordering but preserves constraints", () =>
  Effect.gen(function* () {
    const left = {
      wire: {
        type: "object",
        description: "display-only description",
        required: ["beta", "alpha"],
        properties: {
          alpha: { type: "string", title: "Alpha" },
          beta: { type: "number", minimum: 1 },
        },
        anyOf: [{ type: "string" }, { type: "number" }],
      },
    };
    const annotationAndOrderOnly = {
      wire: {
        type: "object",
        description: "changed prose",
        required: ["alpha", "beta"],
        properties: {
          alpha: { type: "string", title: "Changed title", examples: ["a"] },
          beta: { type: "number", minimum: 1 },
        },
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    };
    const constraintChange = {
      wire: {
        ...annotationAndOrderOnly.wire,
        properties: {
          ...annotationAndOrderOnly.wire.properties,
          beta: { type: "number", minimum: 2 },
        },
      },
    };

    expect(yield* canonicalProtocolContractFor(left)).toBe(
      yield* canonicalProtocolContractFor(annotationAndOrderOnly),
    );
    expect(yield* fingerprintProtocolContract(left)).not.toBe(
      yield* fingerprintProtocolContract(constraintChange),
    );
  }),
);

it.effect("keeps annotations outside schema projections semantically significant", () =>
  Effect.gen(function* () {
    expect(yield* fingerprintProtocolContract({ bridge: { description: "first" } })).not.toBe(
      yield* fingerprintProtocolContract({ bridge: { description: "second" } }),
    );
  }),
);

it.effect("omits opaque implementation reasons from the canonical protocol", () =>
  Effect.gen(function* () {
    const contract = JSON.parse(yield* canonicalProtocolContract) as {
      readonly operationResults: {
        readonly page: { readonly evaluate: Readonly<Record<string, unknown>> };
      };
    };

    expect(contract.operationResults.page.evaluate).toMatchObject({
      mode: "opaque",
      deadline: "default",
    });
    expect(contract.operationResults.page.evaluate).not.toHaveProperty("reason");
  }),
);

it.effect("changes the fingerprint when any bridge contract leaf changes", () =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProtocolContract;
    const contract = JSON.parse(canonical) as { readonly bridge: unknown };
    const baseline = yield* fingerprintProtocolContract(contract);
    expect(baseline).toBe(yield* protocolFingerprint);

    const paths = leafPaths(contract.bridge);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const mutated = {
        ...contract,
        bridge: mutateLeaf(contract.bridge, path),
      };
      expect(yield* fingerprintProtocolContract(mutated), path.join(".")).not.toBe(baseline);
    }
  }),
);

it.effect(
  "changes the fingerprint when any operation result contract leaf changes",
  () =>
    Effect.gen(function* () {
      const canonical = yield* canonicalProtocolContract;
      const contract = JSON.parse(canonical) as { readonly operationResults: unknown };
      const baseline = yield* fingerprintProtocolContract(contract);
      expect(baseline).toBe(yield* protocolFingerprint);

      const paths = leafPaths(contract.operationResults);
      expect(paths.length).toBeGreaterThan(30);
      for (const path of paths) {
        const mutated = {
          ...contract,
          operationResults: mutateLeaf(contract.operationResults, path),
        };
        expect(yield* fingerprintProtocolContract(mutated), path.join(".")).not.toBe(baseline);
      }
    }),
  // This gate intentionally hashes every result-contract leaf. Its runtime grows linearly with
  // the protocol; optimize or shard the exhaustive check before raising this budget again.
  30_000,
);

it.effect("changes the fingerprint when any evaluation projector contract leaf changes", () =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProtocolContract;
    const contract = JSON.parse(canonical) as { readonly evaluationValues: unknown };
    const baseline = yield* fingerprintProtocolContract(contract);
    expect(baseline).toBe(yield* protocolFingerprint);

    const paths = leafPaths(contract.evaluationValues);
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      const mutated = {
        ...contract,
        evaluationValues: mutateLeaf(contract.evaluationValues, path),
      };
      expect(yield* fingerprintProtocolContract(mutated), path.join(".")).not.toBe(baseline);
    }
  }),
);

it.effect("changes the fingerprint when any authentication message leaf changes", () =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProtocolContract;
    const contract = JSON.parse(canonical) as { readonly authenticationMessages: unknown };
    const baseline = yield* fingerprintProtocolContract(contract);
    expect(baseline).toBe(yield* protocolFingerprint);

    const paths = leafPaths(contract.authenticationMessages);
    expect(paths.length).toBe(4);
    for (const path of paths) {
      const mutated = {
        ...contract,
        authenticationMessages: mutateLeaf(contract.authenticationMessages, path),
      };
      expect(yield* fingerprintProtocolContract(mutated), path.join(".")).not.toBe(baseline);
    }
  }),
);

it.effect("binds the Pipee companion identity into the connector fingerprint", () =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProtocolContract;
    const contract = JSON.parse(canonical) as { readonly browserCompanion: string };
    const changed = {
      ...contract,
      browserCompanion: `${contract.browserCompanion}-retired`,
    };

    expect(yield* fingerprintProtocolContract(changed)).not.toBe(
      yield* fingerprintProtocolContract(contract),
    );
  }),
);

it.effect("versions evaluation projector algorithm changes explicitly", () =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProtocolContract;
    const contract = JSON.parse(canonical) as {
      readonly evaluationValues: typeof EVALUATION_VALUE_CONTRACT;
    };
    const changed = {
      ...contract,
      evaluationValues: {
        ...contract.evaluationValues,
        algorithmVersion: contract.evaluationValues.algorithmVersion + 1,
      },
    };

    expect(yield* fingerprintProtocolContract(changed)).not.toBe(
      yield* fingerprintProtocolContract(contract),
    );
  }),
);
