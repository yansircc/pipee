import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ZeroYConnectorError, connectorGet } from "../src/domain/client.js";

describe("zeroY Connector errors", () => {
  it.effect("preserves the Connector status, code, and structured data", () => {
    const originalFetch = globalThis.fetch;
    const payload = JSON.stringify({
      error: {
        code: "zeroy_schema_invalid",
        message: "ThemeSchema is invalid.",
        data: { status: 409, violations: [{ code: "schema_node_boolean_required" }] },
      },
    });
    return Effect.sync(() => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 409,
          text: () => Promise.resolve(payload),
        } as Response)) as typeof fetch;
    }).pipe(
      Effect.andThen(
        connectorGet(
          {
            siteId: "site",
            label: "Test site",
            endpoint: "https://example.test",
            grant: null,
            connectionKey: "key",
          },
          "schema",
        ).pipe(Effect.flip),
      ),
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(ZeroYConnectorError);
          expect(error).toMatchObject({
            message: "ThemeSchema is invalid.",
            status: 409,
            code: "zeroy_schema_invalid",
            data: { violations: [{ code: "schema_node_boolean_required" }] },
          });
        }),
      ),
      Effect.ensuring(Effect.sync(() => (globalThis.fetch = originalFetch))),
    );
  });
});
