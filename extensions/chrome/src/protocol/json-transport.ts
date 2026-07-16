import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { REQUEST_BODY_BYTE_LIMIT } from "./bridge-contract.js";

export class JsonTransportFailure extends Data.TaggedError("JsonTransportFailure")<{
  readonly label: string;
  readonly message: string;
  readonly limitBytes: number;
  readonly actualBytes?: number;
  readonly cause?: unknown;
}> {}

const jsonViolation = (root: unknown): string | undefined => {
  const pending: Array<unknown> = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "contains a non-finite number";
      continue;
    }
    if (typeof value !== "object") return `contains ${typeof value}`;
    if (seen.has(value)) return "contains a circular or aliased object graph";
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return "contains a sparse array";
        pending.push(value[index]);
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "contains a non-plain object";
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return "contains a symbol key";
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return "contains a non-enumerable or accessor property";
      }
      pending.push(descriptor.value);
    }
  }
  return undefined;
};

export type EncodedJson<Value> = {
  readonly value: Value;
  readonly json: string;
  readonly byteLength: number;
};

export const encodeJsonTransport = <S extends Schema.ConstraintDecoder<unknown>>(
  label: string,
  schema: S,
  value: unknown,
  limitBytes = REQUEST_BODY_BYTE_LIMIT,
): Effect.Effect<EncodedJson<S["Type"]>, JsonTransportFailure, S["DecodingServices"]> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      return yield* new JsonTransportFailure({
        label,
        message: `${label} byte limit must be a non-negative safe integer`,
        limitBytes,
      });
    }
    const violation = yield* Effect.try({
      try: () => jsonViolation(value),
      catch: (cause) =>
        new JsonTransportFailure({
          label,
          message: `${label} could not be inspected as JSON`,
          limitBytes,
          cause,
        }),
    });
    if (violation) {
      return yield* new JsonTransportFailure({
        label,
        message: `${label} is not a JSON value: ${violation}`,
        limitBytes,
      });
    }
    const json = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) =>
        new JsonTransportFailure({
          label,
          message: `${label} could not be encoded as JSON`,
          limitBytes,
          cause,
        }),
    });
    if (json === undefined) {
      return yield* new JsonTransportFailure({
        label,
        message: `${label} did not encode to a JSON document`,
        limitBytes,
      });
    }
    const byteLength = yield* Effect.try({
      try: () => new TextEncoder().encode(json).byteLength,
      catch: (cause) =>
        new JsonTransportFailure({
          label,
          message: `${label} byte length could not be measured`,
          limitBytes,
          cause,
        }),
    });
    if (byteLength > limitBytes) {
      return yield* new JsonTransportFailure({
        label,
        message: `${label} is ${byteLength} bytes; limit is ${limitBytes} bytes`,
        limitBytes,
        actualBytes: byteLength,
      });
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(json),
      catch: (cause) =>
        new JsonTransportFailure({
          label,
          message: `${label} could not be decoded from its JSON document`,
          limitBytes,
          actualBytes: byteLength,
          cause,
        }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
      parsed,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new JsonTransportFailure({
            label,
            message: `${label} does not match its wire schema`,
            limitBytes,
            actualBytes: byteLength,
            cause,
          }),
      ),
    );
    return { value: decoded, json, byteLength };
  });
