import * as Schema from "effect/Schema";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Codec<JsonValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<JsonValue> => JsonValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<JsonValue> => JsonValue),
  ),
]);
