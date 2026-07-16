import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { encodeJsonTransport, JsonTransportFailure } from "../../src/protocol/json-transport.js";
import { ForwardResponse, WireResult } from "../../src/protocol/schema.js";

it.effect("round-trips normal JSON through its wire schema", () =>
  Effect.gen(function* () {
    const encoded = yield* encodeJsonTransport("wire result", WireResult, {
      id: "json-result",
      ok: true,
      value: { nested: [1, "two", null, true] },
    });

    expect(encoded.value).toEqual({
      id: "json-result",
      ok: true,
      value: { nested: [1, "two", null, true] },
    });
    expect(encoded.byteLength).toBe(new TextEncoder().encode(encoded.json).byteLength);
  }),
);

it.effect("rejects values that JSON would erase or coerce", () =>
  Effect.gen(function* () {
    const invalid = [
      { schema: WireResult, value: { id: "undefined", ok: true, value: undefined } },
      { schema: WireResult, value: { id: "bigint", ok: true, value: 1n } },
      { schema: ForwardResponse, value: { ok: true, value: undefined } },
      { schema: ForwardResponse, value: { ok: true, value: 1n } },
    ] as const;

    for (const { schema, value } of invalid) {
      expect((yield* Effect.exit(encodeJsonTransport("invalid JSON", schema, value)))._tag).toBe(
        "Failure",
      );
    }
  }),
);

it.effect("rejects circular, aliased, sparse, and non-finite JSON graphs", () =>
  Effect.gen(function* () {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const shared = { value: 1 };
    const sparse: Array<unknown> = [];
    sparse.length = 2;
    sparse[1] = "present";

    for (const value of [
      circular,
      { left: shared, right: shared },
      sparse,
      { value: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        (yield* Effect.exit(
          encodeJsonTransport("invalid graph", ForwardResponse, { ok: true, value }),
        ))._tag,
      ).toBe("Failure");
    }
  }),
);

it.effect("turns hostile object inspection and invalid limits into typed failures", () =>
  Effect.gen(function* () {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(
      yield* encodeJsonTransport("hostile JSON", ForwardResponse, {
        ok: true,
        value: revocable.proxy,
      }).pipe(Effect.flip),
    ).toBeInstanceOf(JsonTransportFailure);

    for (const limit of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        yield* encodeJsonTransport(
          "invalid limit",
          ForwardResponse,
          { ok: true, value: null },
          limit,
        ).pipe(Effect.flip),
      ).toBeInstanceOf(JsonTransportFailure);
    }
  }),
);
