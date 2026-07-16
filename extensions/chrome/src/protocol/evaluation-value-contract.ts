export const EVALUATION_VALUE_CONTRACT = {
  algorithmVersion: 2,
  marker: {
    tag: "PiChromeEvaluationMarker",
    kinds: {
      arrayHole: "ArrayHole",
      bigint: "BigInt",
      circularReference: "CircularReference",
      collectionLimit: "CollectionLimit",
      depthLimit: "DepthLimit",
      error: "Error",
      function: "Function",
      keyTruncated: "KeyTruncated",
      negativeZero: "NegativeZero",
      nodeLimit: "NodeLimit",
      nonFiniteNumber: "NonFiniteNumber",
      nonPlainObject: "NonPlainObject",
      objectEntryProjection: "ObjectEntryProjection",
      propertyAccessError: "PropertyAccessError",
      sharedReference: "SharedReference",
      stringTruncated: "StringTruncated",
      symbol: "Symbol",
      symbolKey: "SymbolKey",
      undefined: "Undefined",
      uninspectableObject: "UninspectableObject",
    },
  },
  limits: {
    nodes: 512,
    depth: 12,
    collectionEntries: 128,
    stringLength: 2_000,
    keyLength: 256,
  },
  rendering: {
    nonFiniteNumbers: {
      nan: "NaN",
      positiveInfinity: "Infinity",
      negativeInfinity: "-Infinity",
    },
    arrayCollectionName: "Array",
    unprintableError: "[unprintable error]",
  },
  plainObjectPolicy: {
    properties: "own-enumerable-string-keys",
    outputPrototype: "null",
  },
  nonPlainObjectPolicy: {
    shape: "marker-with-constructor-name-object-tag-and-projected-properties",
    properties: "plain-object-policy",
  },
  referencePolicy: {
    identity: "depth-first-first-seen",
    subjects: "objects-and-functions-before-type-projection",
    circular: "active-reference-marker",
    shared: "inactive-reference-marker",
    projectedMarkers: "carry-reference-id-after-allocation",
  },
  keyPolicy: {
    order: "string-keys-then-symbol-keys",
    symbol: "entry-projection",
    oversized: "entry-projection",
    overflow: "collection-limit-marker",
  },
  arrayPolicy: {
    holes: "array-hole-marker",
    overflow: "trailing-collection-limit-marker",
  },
  domRectPolicy: {
    detection: "numeric-geometry-and-to-json-or-no-enumerable-strings",
    fields: ["x", "y", "width", "height", "top", "right", "bottom", "left"],
  },
} as const;

type WidenContract<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends ReadonlyArray<infer Entry>
      ? ReadonlyArray<WidenContract<Entry>>
      : Value extends Readonly<Record<string, unknown>>
        ? { readonly [Key in keyof Value]: WidenContract<Value[Key]> }
        : Value;

export type EvaluationValueContract = WidenContract<typeof EVALUATION_VALUE_CONTRACT>;
