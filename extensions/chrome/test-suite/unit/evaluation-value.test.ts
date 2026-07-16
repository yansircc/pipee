import { runInNewContext } from "node:vm";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { projectEvaluationValue } from "../../src/browser/injected/evaluation-value.js";
import { EVALUATION_VALUE_CONTRACT } from "../../src/protocol/evaluation-value-contract.js";
import { JsonValue } from "../../src/protocol/json-value.js";

type Marker = {
  readonly _tag: "PiChromeEvaluationMarker";
  readonly kind: string;
  readonly [key: string]: unknown;
};

const marker = (value: unknown): Marker => value as Marker;
const project = (value: unknown) => projectEvaluationValue(value, EVALUATION_VALUE_CONTRACT);
const containsMarker = (value: unknown, kind: string): boolean => {
  if (typeof value !== "object" || value === null) return false;
  if (!Array.isArray(value) && marker(value).kind === kind) return true;
  return Object.values(value).some((child) => containsMarker(child, kind));
};

it("preserves ordinary JSON shapes and is self-contained after toString", () => {
  const input = {
    null: null,
    boolean: true,
    number: 42.5,
    string: "value",
    array: [1, "two", false],
    object: { nested: "yes" },
  };
  const expected = project(input);

  expect(expected).toEqual(input);
  expect(
    runInNewContext(`(${projectEvaluationValue.toString()})(JSON.parse(encoded), contract)`, {
      encoded: JSON.stringify(input),
      contract: structuredClone(EVALUATION_VALUE_CONTRACT),
    }),
  ).toEqual(expected);
  expect(projectEvaluationValue.toString()).not.toContain("JsonValue");
});

it("derives marker names and limits from the supplied protocol contract", () => {
  const contract = {
    ...EVALUATION_VALUE_CONTRACT,
    marker: {
      ...EVALUATION_VALUE_CONTRACT.marker,
      tag: "ContractMarker",
      kinds: {
        ...EVALUATION_VALUE_CONTRACT.marker.kinds,
        stringTruncated: "ContractStringLimit",
      },
    },
    limits: { ...EVALUATION_VALUE_CONTRACT.limits, stringLength: 2 },
  };

  expect(projectEvaluationValue("abcd", contract)).toEqual({
    _tag: "ContractMarker",
    kind: "ContractStringLimit",
    prefix: "ab",
    originalLength: 4,
  });
});

it("preserves prototype-shaped own keys without invoking object prototype setters", () => {
  const input = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"constructor","prototype":"prototype"}',
  ) as Record<string, unknown>;

  const projected = project(input) as Record<string, JsonValue>;
  const encoded = JSON.stringify(projected);

  expect(Object.hasOwn(projected, "__proto__")).toBe(true);
  expect(JSON.parse(encoded)).toEqual(input);
  expect(Schema.decodeUnknownSync(JsonValue)(JSON.parse(encoded))).toEqual(input);
  expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
});

it("projects hostile object, array, and function proxies as bounded uninspectable values", () => {
  const objectProxy = Proxy.revocable({}, {});
  const arrayProxy = Proxy.revocable([], {});
  const functionProxy = Proxy.revocable(() => undefined, {});
  objectProxy.revoke();
  arrayProxy.revoke();
  functionProxy.revoke();
  const hostileArray = new Proxy([], {
    get: (target, key, receiver) => {
      if (key === "length") throw new Error("length denied");
      return Reflect.get(target, key, receiver);
    },
  });

  for (const value of [objectProxy.proxy, arrayProxy.proxy, functionProxy.proxy, hostileArray]) {
    const projected = project(value);
    const encoded = JSON.stringify(projected);

    expect(marker(projected).kind).toBe("UninspectableObject");
    expect(encoded).toBeTypeOf("string");
    expect(Schema.decodeUnknownSync(JsonValue)(JSON.parse(encoded))).toEqual(projected);
  }
});

it("keeps aliases connected to every specialized or failed object projection", () => {
  const hostileArray = new Proxy([], {
    get: (target, key, receiver) => {
      if (key === "length") throw new Error("length denied");
      return Reflect.get(target, key, receiver);
    },
  });
  const values = [
    { value: hostileArray, kind: "UninspectableObject" },
    { value: function aliasedFunction() {}, kind: "Function" },
    { value: new Error("aliased error"), kind: "Error" },
  ];

  for (const entry of values) {
    const projected = project([entry.value, entry.value]) as ReadonlyArray<unknown>;
    const first = marker(projected[0]);
    const second = marker(projected[1]);

    expect(first).toMatchObject({ kind: entry.kind, referenceId: expect.any(Number) });
    expect(second).toMatchObject({ kind: "SharedReference", referenceId: first.referenceId });
    expect(Schema.decodeUnknownSync(JsonValue)(JSON.parse(JSON.stringify(projected)))).toEqual(
      projected,
    );
  }
});

it("marks every non-JSON scalar at top level and when nested", () => {
  expect(marker(project(undefined)).kind).toBe("Undefined");

  const error = new Error("failed");
  error.stack = "stack".repeat(1_000);
  const output = project({
    undefinedValue: undefined,
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    negativeZero: -0,
    bigint: BigInt("9".repeat(3_000)),
    symbol: Symbol("s".repeat(3_000)),
    function: function example() {
      return 1;
    },
    error,
  }) as Record<string, unknown>;

  expect(Object.hasOwn(output, "undefinedValue")).toBe(true);
  expect(marker(output.undefinedValue).kind).toBe("Undefined");
  expect(marker(output.nan)).toMatchObject({ kind: "NonFiniteNumber", value: "NaN" });
  expect(marker(output.positiveInfinity)).toMatchObject({
    kind: "NonFiniteNumber",
    value: "Infinity",
  });
  expect(marker(output.negativeInfinity)).toMatchObject({
    kind: "NonFiniteNumber",
    value: "-Infinity",
  });
  expect(marker(output.negativeZero).kind).toBe("NegativeZero");
  expect(marker(output.bigint)).toMatchObject({ kind: "BigInt" });
  expect(marker(marker(output.bigint).value).kind).toBe("StringTruncated");
  expect(marker(output.symbol)).toMatchObject({ kind: "Symbol" });
  expect(marker(marker(output.symbol).description).kind).toBe("StringTruncated");
  expect(marker(output.function).kind).toBe("Function");
  expect(marker(output.error).kind).toBe("Error");
  expect(marker(marker(output.error).stack).kind).toBe("StringTruncated");
});

it("distinguishes circular and shared references", () => {
  const shared = { value: 1 };
  const input: Record<string, unknown> = { first: shared, second: shared };
  input.self = input;
  const output = project(input) as Record<string, unknown>;

  expect(marker(output.self)).toMatchObject({ kind: "CircularReference", referenceId: 1 });
  expect(marker(output.second)).toMatchObject({ kind: "SharedReference", referenceId: 2 });
});

it("expands DOMRect-like values and preserves array holes explicitly", () => {
  const rect: Record<string, unknown> = {};
  const geometry = {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    top: 2,
    right: 4,
    bottom: 6,
    left: 1,
  };
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(rect, key, { value, enumerable: false });
  }
  Object.defineProperty(rect, "toJSON", { value: () => geometry, enumerable: false });
  const input: Array<unknown> = [];
  input.length = 2;
  input[1] = rect;

  const output = project(input) as ReadonlyArray<unknown>;
  expect(marker(output[0]).kind).toBe("ArrayHole");
  expect(output[1]).toEqual(geometry);
});

it("marks non-plain objects instead of silently flattening them", () => {
  const date = marker(project(new Date("2026-01-02T03:04:05.000Z")));
  const map = marker(project(new Map([["key", "value"]])));
  const regexp = marker(project(/pi-chrome/gi));

  expect(date).toMatchObject({
    kind: "NonPlainObject",
    constructorName: "Date",
    objectTag: "[object Date]",
    properties: {},
  });
  expect(map).toMatchObject({
    kind: "NonPlainObject",
    constructorName: "Map",
    objectTag: "[object Map]",
    properties: {},
  });
  expect(regexp).toMatchObject({
    kind: "NonPlainObject",
    constructorName: "RegExp",
    objectTag: "[object RegExp]",
    properties: {},
  });

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.value = 1;
  expect(project(nullPrototype)).toEqual({ value: 1 });
});

it("makes string, key, collection, depth, node, and property limits explicit", () => {
  const longString = marker(project("x".repeat(3_000)));
  expect(longString).toMatchObject({ kind: "StringTruncated", originalLength: 3_000 });
  expect(String(longString.prefix)).toHaveLength(2_000);

  const longKey = "k".repeat(300);
  const keyed = marker(project({ [longKey]: "value" }));
  expect(keyed.kind).toBe("ObjectEntryProjection");
  const firstEntry = (keyed.entries as ReadonlyArray<Record<string, unknown>>)[0]!;
  expect(marker(firstEntry.key).kind).toBe("KeyTruncated");

  const largeArray = project(Array.from({ length: 200 }, (_, index) => index));
  expect(marker((largeArray as ReadonlyArray<unknown>).at(-1)).kind).toBe("CollectionLimit");

  let deep: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 20; index += 1) deep = { child: deep };
  expect(containsMarker(project(deep), "DepthLimit")).toBe(true);

  const broad = Array.from({ length: 128 }, () =>
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`key-${index}`, index])),
  );
  expect(containsMarker(project(broad), "NodeLimit")).toBe(true);

  const throwing = {};
  Object.defineProperty(throwing, "value", {
    enumerable: true,
    get: () => {
      throw new Error("getter failed");
    },
  });
  const projectedThrowing = project(throwing) as Record<string, unknown>;
  expect(marker(projectedThrowing.value).kind).toBe("PropertyAccessError");
});

it("always survives JSON.stringify and JsonValue schema decoding", () => {
  const cyclic: Record<string, unknown> = {
    undefined: undefined,
    values: [Number.NaN, 1n, Symbol("symbol")],
  };
  cyclic.self = cyclic;
  const projected = project(cyclic);
  const encoded = JSON.stringify(projected);

  expect(encoded).toBeTypeOf("string");
  expect(Schema.decodeUnknownSync(JsonValue)(JSON.parse(encoded))).toEqual(projected);
});
