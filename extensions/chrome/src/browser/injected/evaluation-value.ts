import type { JsonValue } from "../../protocol/json-value.js";
import type { EvaluationValueContract } from "../../protocol/evaluation-value-contract.js";

export function projectEvaluationValue(
  input: unknown,
  contract: EvaluationValueContract,
): JsonValue {
  type JsonObject = { [key: string]: JsonValue };
  const marker = (kind: string, fields: JsonObject = {}): JsonObject => ({
    _tag: contract.marker.tag,
    kind,
    ...fields,
  });
  const boundedString = (value: string): JsonValue =>
    value.length <= contract.limits.stringLength
      ? value
      : marker(contract.marker.kinds.stringTruncated, {
          prefix: value.slice(0, contract.limits.stringLength),
          originalLength: value.length,
        });
  const messageOf = (cause: unknown): JsonValue => {
    try {
      return boundedString(
        String((cause as { readonly message?: unknown } | null | undefined)?.message ?? cause),
      );
    } catch {
      return contract.rendering.unprintableError;
    }
  };
  const uninspectableObject = (cause: unknown, referenceId?: number): JsonValue =>
    marker(contract.marker.kinds.uninspectableObject, {
      ...(referenceId === undefined ? {} : { referenceId }),
      message: messageOf(cause),
    });
  type ObjectReflection = {
    readonly prototype: object | null;
    readonly array: boolean;
    readonly error: boolean;
  };
  const reflectObject = (
    value: object,
  ):
    | { readonly ok: true; readonly reflection: ObjectReflection }
    | {
        readonly ok: false;
        readonly cause: unknown;
      } => {
    try {
      return {
        ok: true,
        reflection: {
          prototype: Object.getPrototypeOf(value),
          array: Array.isArray(value),
          error: value instanceof Error,
        },
      };
    } catch (cause) {
      return {
        ok: false,
        cause,
      };
    }
  };
  let project: (value: unknown, depth: number) => JsonValue;
  const property = (value: object, key: PropertyKey, depth: number): JsonValue => {
    try {
      return project((value as Readonly<Record<PropertyKey, unknown>>)[key], depth);
    } catch (cause) {
      return marker(contract.marker.kinds.propertyAccessError, { message: messageOf(cause) });
    }
  };
  const projectArray = (
    value: ReadonlyArray<unknown>,
    depth: number,
    referenceId: number,
  ): JsonValue => {
    try {
      const result: Array<JsonValue> = [];
      const count = Math.min(value.length, contract.limits.collectionEntries);
      for (let index = 0; index < count; index += 1) {
        result.push(
          Object.hasOwn(value, index)
            ? project(value[index], depth + 1)
            : marker(contract.marker.kinds.arrayHole, { index }),
        );
      }
      if (value.length > count) {
        result.push(
          marker(contract.marker.kinds.collectionLimit, {
            collection: contract.rendering.arrayCollectionName,
            omitted: value.length - count,
            limit: contract.limits.collectionEntries,
          }),
        );
      }
      return result;
    } catch (cause) {
      return uninspectableObject(cause, referenceId);
    }
  };

  let remainingNodes = contract.limits.nodes;
  let nextReferenceId = 1;
  const references = new WeakMap<object, number>();
  const active = new WeakSet<object>();

  project = (value: unknown, depth: number): JsonValue => {
    if (remainingNodes <= 0) {
      return marker(contract.marker.kinds.nodeLimit, { limit: contract.limits.nodes });
    }
    remainingNodes -= 1;
    if (depth >= contract.limits.depth) {
      return marker(contract.marker.kinds.depthLimit, { depth, limit: contract.limits.depth });
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return boundedString(value);
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        return marker(contract.marker.kinds.nonFiniteNumber, {
          value: contract.rendering.nonFiniteNumbers.nan,
        });
      }
      if (value === Number.POSITIVE_INFINITY)
        return marker(contract.marker.kinds.nonFiniteNumber, {
          value: contract.rendering.nonFiniteNumbers.positiveInfinity,
        });
      if (value === Number.NEGATIVE_INFINITY)
        return marker(contract.marker.kinds.nonFiniteNumber, {
          value: contract.rendering.nonFiniteNumbers.negativeInfinity,
        });
      if (Object.is(value, -0)) return marker(contract.marker.kinds.negativeZero);
      return value;
    }
    if (value === undefined) return marker(contract.marker.kinds.undefined);
    if (typeof value === "bigint")
      return marker(contract.marker.kinds.bigint, { value: boundedString(value.toString()) });
    if (typeof value === "symbol") {
      return marker(contract.marker.kinds.symbol, {
        description:
          value.description === undefined
            ? marker(contract.marker.kinds.undefined)
            : boundedString(value.description),
      });
    }
    const knownReference = references.get(value);
    if (knownReference !== undefined) {
      return marker(
        active.has(value)
          ? contract.marker.kinds.circularReference
          : contract.marker.kinds.sharedReference,
        { referenceId: knownReference },
      );
    }
    const referenceId = nextReferenceId++;
    references.set(value, referenceId);
    active.add(value);
    try {
      const reflected = reflectObject(value);
      if (!reflected.ok) return uninspectableObject(reflected.cause, referenceId);
      const reflection = reflected.reflection;
      if (typeof value === "function") {
        try {
          return marker(contract.marker.kinds.function, {
            referenceId,
            source: boundedString(Function.prototype.toString.call(value)),
          });
        } catch (cause) {
          return uninspectableObject(cause, referenceId);
        }
      }
      if (reflection.error) {
        return marker(contract.marker.kinds.error, {
          referenceId,
          name: property(value, "name", depth + 1),
          message: property(value, "message", depth + 1),
          stack: property(value, "stack", depth + 1),
        });
      }
      if (reflection.array) {
        return projectArray(value as ReadonlyArray<unknown>, depth, referenceId);
      }

      let stringKeys: Array<string>;
      let symbolKeys: Array<symbol>;
      try {
        stringKeys = Object.keys(value);
        symbolKeys = Object.getOwnPropertySymbols(value).filter(
          (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
        );
      } catch (cause) {
        return uninspectableObject(cause, referenceId);
      }

      const geometryKeys = contract.domRectPolicy.fields;
      let domRectLike = false;
      try {
        const record = value as Readonly<Record<string, unknown>>;
        domRectLike =
          geometryKeys.every((key) => typeof record[key] === "number") &&
          (typeof record.toJSON === "function" || stringKeys.length === 0);
      } catch {}
      if (domRectLike) {
        return Object.fromEntries(
          geometryKeys.map((key) => [key, property(value, key, depth + 1)]),
        ) as JsonObject;
      }

      const oversizedKey = stringKeys.some((key) => key.length > contract.limits.keyLength);
      const requiresEntryProjection =
        oversizedKey ||
        symbolKeys.length > 0 ||
        stringKeys.length > contract.limits.collectionEntries;
      const projectEnumerableProperties = (): JsonValue => {
        if (requiresEntryProjection) {
          const keys: Array<string | symbol> = [...stringKeys, ...symbolKeys];
          const count = Math.min(keys.length, contract.limits.collectionEntries);
          const entries: Array<JsonValue> = [];
          for (let index = 0; index < count; index += 1) {
            const key = keys[index]!;
            const projectedKey =
              typeof key === "symbol"
                ? marker(contract.marker.kinds.symbolKey, {
                    description:
                      key.description === undefined
                        ? marker(contract.marker.kinds.undefined)
                        : boundedString(key.description),
                  })
                : key.length <= contract.limits.keyLength
                  ? key
                  : marker(contract.marker.kinds.keyTruncated, {
                      prefix: key.slice(0, contract.limits.keyLength),
                      originalLength: key.length,
                    });
            entries.push({
              key: projectedKey,
              value: property(value, key, depth + 1),
            });
          }
          return marker(contract.marker.kinds.objectEntryProjection, {
            referenceId,
            entries,
            omitted: keys.length - count,
            limit: contract.limits.collectionEntries,
          });
        }

        const result = Object.create(null) as JsonObject;
        for (const key of stringKeys) {
          result[key] = property(value, key, depth + 1);
        }
        return result;
      };

      const prototype = reflection.prototype;
      if (prototype !== null && prototype !== Object.prototype) {
        let constructorName: JsonValue = marker(contract.marker.kinds.undefined);
        let objectTag: JsonValue = marker(contract.marker.kinds.undefined);
        try {
          const constructor = (prototype as { readonly constructor?: unknown }).constructor;
          if (typeof constructor === "function") constructorName = boundedString(constructor.name);
        } catch (cause) {
          constructorName = marker(contract.marker.kinds.propertyAccessError, {
            message: messageOf(cause),
          });
        }
        try {
          objectTag = boundedString(Object.prototype.toString.call(value));
        } catch (cause) {
          objectTag = marker(contract.marker.kinds.propertyAccessError, {
            message: messageOf(cause),
          });
        }
        return marker(contract.marker.kinds.nonPlainObject, {
          referenceId,
          constructorName,
          objectTag,
          properties: projectEnumerableProperties(),
        });
      }

      return projectEnumerableProperties();
    } finally {
      active.delete(value);
    }
  };

  return project(input, 0);
}
