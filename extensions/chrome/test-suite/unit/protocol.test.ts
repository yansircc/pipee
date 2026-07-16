import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BridgeStopped,
  BridgeUnavailable,
  CommandOutcomeUnknown,
  CommandRejected,
  CommandTimeout,
  ConnectorAlreadyBound,
  ConnectorBindingMismatch,
  ConnectorNotBound,
  ConnectorOffline,
  ProtocolFailure,
  type BridgeFailure,
} from "../../src/core/errors.js";
import {
  decodeAtomicToolRequest,
  decodeDomainRequest,
  decodeBridgeStatusJson,
  decodeForwardRequestJson,
  decodeWireResultJson,
  fromWireBridgeFailure,
  projectDomainRequest,
  toWireBridgeFailure,
} from "../../src/protocol/codec.js";
import { EXTENSION_PUBLIC_KEY } from "../../src/protocol/connector-auth.js";
import { BRIDGE_ORIGIN } from "../../src/protocol/bridge-contract.js";
import { UPLOAD_LIMITS } from "../../src/protocol/operation-schemas.js";
import {
  ATOMIC_TOOL_DESCRIPTORS,
  publicToolCallContract,
} from "../../src/protocol/operation-contract.js";
import { InputCall, PageCall, TabCall, toJsonSchema } from "../../src/protocol/schema.js";
import browserManifest from "../../src/browser/manifest.json" with { type: "json" };
import {
  EXTENSION_PACKAGE_ID,
  extensionPackageIdFromPublicKey,
} from "../../src/pi/extension-package.js";
import {
  bridgeDeliveryTimeoutMs,
  browserExecutionTimeoutMs,
  RESULT_DELIVERY_GRACE_MS,
} from "../../src/protocol/timeout.js";
import manifest from "../manifest.json" with { type: "json" };

it.effect("decodes the three internal domain call algebras", () =>
  Effect.gen(function* () {
    const tab = yield* decodeDomainRequest("tab", {
      op: "activate",
      target: { by: "id", value: 42 },
    });
    const page = yield* decodeDomainRequest("page", {
      target: { by: "url", value: "example.test" },
      op: "wait",
      condition: { by: "selector", value: "#ready" },
    });
    const input = yield* decodeDomainRequest("input", {
      op: "click",
      at: { by: "uid", value: "el-1" },
      includeSnapshot: true,
    });

    expect(tab.domain).toBe("tab");
    expect(page.domain).toBe("page");
    expect(input.domain).toBe("input");
  }),
);

it.effect("keeps generated prompt examples inside the public call algebra", () =>
  Effect.forEach(
    Object.entries(publicToolCallContract),
    ([domain, contract]) =>
      decodeDomainRequest(domain as "tab" | "page" | "input", contract.example),
    { discard: true },
  ),
);

it.effect("projects direct Action Graph refs into the single wire target algebra", () =>
  Effect.gen(function* () {
    const click = yield* decodeAtomicToolRequest("chrome_click", {
      ref: "@el-12",
      includeSnapshot: true,
    });
    const press = yield* decodeAtomicToolRequest("chrome_press", {
      ref: "el-13",
      key: "Enter",
    });

    expect(click).toEqual({
      domain: "input",
      call: {
        operation: {
          kind: "click",
          at: { by: "uid", value: "el-12" },
          includeSnapshot: true,
        },
      },
    });
    expect(press).toEqual({
      domain: "input",
      call: {
        operation: {
          kind: "key",
          key: "Enter",
          at: { by: "uid", value: "el-13" },
        },
      },
    });
  }),
);

it.effect("rejects shapes outside the operation algebra", () =>
  Effect.gen(function* () {
    const invalidTab = yield* Effect.exit(decodeDomainRequest("tab", { op: "snapshot" }));
    const invalidInput = yield* Effect.exit(
      decodeDomainRequest("input", {
        op: "click",
        selector: "#legacy",
      }),
    );
    expect(invalidTab._tag).toBe("Failure");
    expect(invalidInput._tag).toBe("Failure");
  }),
);

it.effect("returns one bounded corrective contract for malformed tool parameters", () =>
  Effect.gen(function* () {
    const failure = yield* decodeDomainRequest("page", {
      operation: { kind: "snapshot" },
    }).pipe(Effect.flip);

    expect(failure.message).toContain("Invalid chrome_page parameters");
    expect(failure.message).toContain("Use one top-level op");
    expect(failure.message).toContain('{"op":"snapshot","mode":"text"}');
    expect(failure.message.length).toBeLessThan(1_200);
  }),
);

it.effect("rejects semantically invalid public inputs at the protocol boundary", () =>
  Effect.gen(function* () {
    const invalidRequests = [
      ["tab", { op: "activate", target: { by: "id", value: "42" } }],
      ["tab", { op: "activate", target: { by: "id", value: -1 } }],
      ["tab", { op: "activate", target: { by: "title", value: "   " } }],
      ["tab", { op: "group", groupColor: "teal" }],
      ["page", { op: "navigate", url: "https://example.test", timeoutMs: 0 }],
      ["page", { op: "snapshot", maxElements: 81 }],
      ["page", { op: "snapshot", maxTextChars: 100_001 }],
      ["page", { op: "read", maxChars: 24_001 }],
      [
        "page",
        {
          op: "navigate",
          url: "https://example.test",
          snapshot: { maxTextChars: 100_001 },
        },
      ],
      ["page", { op: "wait", condition: { by: "selector", value: "" } }],
      ["page", { op: "wait", condition: { by: "networkIdle", value: "x" } }],
      [
        "page",
        {
          op: "screenshot",
          format: "jpeg",
          quality: 101,
          capture: { kind: "viewport" },
        },
      ],
      [
        "page",
        {
          op: "screenshot",
          format: "png",
          quality: 80,
          capture: { kind: "viewport" },
        },
      ],
      ["page", { op: "screenshot", capture: { kind: "viewport" } }],
      [
        "page",
        {
          op: "screenshot",
          format: "png",
          capture: { kind: "viewport", path: "/tmp/capture.png" },
        },
      ],
      [
        "page",
        {
          op: "screenshot",
          format: "png",
          capture: { kind: "viewport", path: "../capture.png" },
        },
      ],
      [
        "page",
        {
          op: "screenshot",
          format: "png",
          capture: { kind: "viewport", path: "captures\\capture.png" },
        },
      ],
      ["input", { op: "type", text: "x".repeat(501) }],
      [
        "input",
        {
          op: "drag",
          from: { by: "uid", value: "a" },
          to: { by: "uid", value: "b" },
          steps: 41,
        },
      ],
      ["input", { op: "upload", into: { by: "selector", value: "input" }, paths: [] }],
      [
        "input",
        {
          op: "upload",
          into: { by: "selector", value: "input" },
          paths: Array.from({ length: UPLOAD_LIMITS.maxPaths + 1 }, () => "/tmp/file"),
        },
      ],
      [
        "input",
        {
          op: "upload",
          into: { by: "selector", value: "input" },
          paths: ["/".repeat(UPLOAD_LIMITS.maxPathLength + 1)],
        },
      ],
      ["input", { op: "click", at: { by: "selector", value: "\t" } }],
      ["input", { op: "click", at: { by: "coordinate", x: NaN, y: 0 } }],
      ["input", { op: "scroll", deltaY: Number.POSITIVE_INFINITY }],
    ] as const;

    for (const [domain, call] of invalidRequests) {
      const result = yield* Effect.exit(decodeDomainRequest(domain, call));
      expect(result._tag, `${domain}: ${JSON.stringify(call)}`).toBe("Failure");
    }
  }),
);

it.effect("accepts the inclusive public input bounds", () =>
  Effect.gen(function* () {
    yield* decodeDomainRequest("tab", { op: "group", groupColor: "grey" });
    yield* decodeDomainRequest("page", {
      op: "screenshot",
      format: "jpeg",
      quality: 0,
      capture: { kind: "viewport" },
    });
    yield* decodeDomainRequest("page", {
      op: "screenshot",
      format: "jpeg",
      quality: 100,
      capture: { kind: "viewport", path: ".pi/chrome-screenshots/capture.jpeg" },
    });
    yield* decodeDomainRequest("page", {
      op: "screenshot",
      format: "png",
      capture: { kind: "viewport" },
    });
    yield* decodeDomainRequest("page", {
      op: "navigate",
      url: "https://example.test",
      snapshot: { mode: "text", maxTextChars: 100_000 },
    });
    yield* decodeDomainRequest("page", {
      op: "snapshot",
      ref: "@frontier-1",
      maxElements: 80,
    });
    yield* decodeDomainRequest("page", {
      op: "read",
      ref: "@frontier-2",
      view: "outline",
      query: "authentication",
      maxChars: 24_000,
    });
    for (const by of ["selector", "urlIncludes", "textContains", "expression"] as const) {
      yield* decodeDomainRequest("page", {
        op: "wait",
        condition: { by, value: "ready" },
      });
    }
    yield* decodeDomainRequest("page", {
      op: "screenshot",
      format: "png",
      capture: {
        kind: "full-page-tiles",
        directory: ".pi/chrome-screenshots/full-page",
      },
    });
    yield* decodeDomainRequest("input", {
      op: "drag",
      from: { by: "uid", value: "a" },
      to: { by: "uid", value: "b" },
      steps: 40,
    });
    yield* decodeDomainRequest("input", {
      op: "upload",
      into: { by: "selector", value: "input[type=file]" },
      paths: Array.from({ length: UPLOAD_LIMITS.maxPaths }, () =>
        "/".repeat(UPLOAD_LIMITS.maxPathLength),
      ),
    });
  }),
);

it.effect("decodes only tagged terminal command failures", () =>
  Effect.gen(function* () {
    const rejected = yield* decodeWireResultJson(
      JSON.stringify({
        id: "command-1",
        ok: false,
        error: {
          _tag: "CommandRejected",
          code: "ambiguous-owned-target",
          message: "failed",
          details: { ownedTargets: [{ state: "owned", tabId: 7 }] },
        },
      }),
    );
    expect(rejected).toEqual({
      id: "command-1",
      ok: false,
      error: {
        _tag: "CommandRejected",
        code: "ambiguous-owned-target",
        message: "failed",
        details: { ownedTargets: [{ state: "owned", tabId: 7 }] },
      },
    });
    const unknown = yield* decodeWireResultJson(
      JSON.stringify({
        id: "command-2",
        ok: false,
        error: {
          _tag: "CommandOutcomeUnknown",
          message: "execution was interrupted",
          cause: "MV3 restart",
        },
      }),
    );
    expect(unknown.ok ? undefined : unknown.error._tag).toBe("CommandOutcomeUnknown");

    const legacy = yield* Effect.exit(
      decodeWireResultJson(
        JSON.stringify({
          id: "command-3",
          ok: false,
          error: { code: "outcome-unknown", message: "ambiguous" },
        }),
      ),
    );
    expect(legacy._tag).toBe("Failure");
  }),
);

it("emits JSON Schema directly from the protocol owner", () => {
  for (const schema of [TabCall, PageCall, InputCall]) {
    const jsonSchema = toJsonSchema(schema) as Record<string, unknown>;
    const encoded = JSON.stringify(jsonSchema);
    expect(Object.keys(jsonSchema).length).toBeGreaterThan(0);
    expect(encoded).toContain('"op"');
    expect(encoded).not.toContain('"operation"');
    expect(encoded).not.toContain("legacy");
    expect(encoded).not.toContain("domFallback");
  }
});

it.effect("requires the expected connector on owner-forwarded commands", () =>
  Effect.gen(function* () {
    const connectorId = "11111111-1111-4111-8111-111111111111";
    const valid = yield* decodeForwardRequestJson(
      JSON.stringify({
        connector: { source: "terminal", expectedConnectorId: connectorId },
        domain: "tab",
        call: { op: "list" },
        session: { key: "session", groupTitle: "Session", foreground: false },
        timeoutMs: 1_000,
      }),
    );
    expect(valid.connector).toEqual({ source: "terminal", expectedConnectorId: connectorId });

    const missing = yield* Effect.exit(
      decodeForwardRequestJson(
        JSON.stringify({
          domain: "tab",
          call: { op: "list" },
          session: { key: "session", groupTitle: "Session", foreground: false },
          timeoutMs: 1_000,
        }),
      ),
    );
    expect(missing._tag).toBe("Failure");

    for (const impossible of [
      {
        expectedConnectorId: connectorId,
        domain: "page",
        call: { op: "list" },
        session: { key: "session", groupTitle: "Session", foreground: false },
        timeoutMs: 1_000,
      },
      {
        expectedConnectorId: connectorId,
        domain: "tab",
        call: { operation: { kind: "snapshot" } },
        session: { key: "session", groupTitle: "Session", foreground: false },
        timeoutMs: 1_000,
      },
    ]) {
      expect((yield* Effect.exit(decodeForwardRequestJson(JSON.stringify(impossible))))._tag).toBe(
        "Failure",
      );
    }
  }),
);

it.effect("projects tool-only filesystem and foreground fields out of the wire algebra", () =>
  Effect.gen(function* () {
    const pages = yield* Effect.all([
      decodeDomainRequest("page", {
        background: true,
        op: "screenshot",
        format: "png",
        capture: { kind: "viewport", path: ".pi/chrome-screenshots/private.png" },
      }),
      decodeDomainRequest("page", {
        background: true,
        op: "screenshot",
        format: "jpeg",
        quality: 80,
        capture: {
          kind: "full-page-tiles",
          directory: ".pi/chrome-screenshots/private-page",
        },
      }),
    ]);
    const input = yield* decodeDomainRequest("input", {
      background: true,
      op: "click",
      at: { by: "uid", value: "button-1" },
    });

    expect(projectDomainRequest(pages[0])).toEqual({
      domain: "page",
      call: {
        operation: {
          kind: "screenshot",
          format: "png",
          capture: { kind: "viewport" },
        },
      },
    });
    expect(projectDomainRequest(pages[1])).toEqual({
      domain: "page",
      call: {
        operation: {
          kind: "screenshot",
          format: "jpeg",
          quality: 80,
          capture: { kind: "full-page-tiles" },
        },
      },
    });
    expect(projectDomainRequest(input)).toEqual({
      domain: "input",
      call: { operation: { kind: "click", at: { by: "uid", value: "button-1" } } },
    });
    expect(
      JSON.stringify([...pages.map(projectDomainRequest), projectDomainRequest(input)]),
    ).not.toMatch(/path|directory|background/);
  }),
);

it.effect("rejects impossible connector status counters at the owner wire boundary", () =>
  Effect.gen(function* () {
    const status = {
      url: BRIDGE_ORIGIN,
      mode: "server",
      connector: {
        connectorId: "11111111-1111-4111-8111-111111111111",
        connected: true,
        queuedCommands: -1,
        pendingCommands: 0,
      },
    };
    expect((yield* Effect.exit(decodeBridgeStatusJson(JSON.stringify(status))))._tag).toBe(
      "Failure",
    );
  }),
);

it("round-trips every bridge failure tag through the owner wire protocol", () => {
  const failures: ReadonlyArray<BridgeFailure> = [
    new BridgeStopped({ message: "stopped" }),
    new BridgeUnavailable({ message: "unavailable", cause: { message: "refused" } }),
    new ConnectorNotBound({ message: "not bound" }),
    new ConnectorOffline({
      connectorId: "11111111-1111-4111-8111-111111111111",
      message: "offline",
    }),
    new ConnectorBindingMismatch({
      expectedConnectorId: "22222222-2222-4222-8222-222222222222",
      actualConnectorId: "11111111-1111-4111-8111-111111111111",
      message: "mismatch",
    }),
    new ConnectorAlreadyBound({
      actualConnectorId: "11111111-1111-4111-8111-111111111111",
      message: "expected no binding",
    }),
    new CommandTimeout({ timeoutMs: 500, message: "timeout" }),
    new CommandOutcomeUnknown({ message: "unknown", cause: { message: "reset" } }),
    new CommandRejected({ code: "browser-operation", message: "rejected" }),
    new ProtocolFailure({ message: "invalid", cause: { message: "parse" } }),
  ];

  for (const failure of failures) {
    const wire = toWireBridgeFailure(failure);
    const rebuilt = fromWireBridgeFailure(wire);
    expect(rebuilt._tag).toBe(failure._tag);
    expect(toWireBridgeFailure(rebuilt)).toEqual(wire);
  }
});

it.effect("keeps every benchmark recipe inside the generated atomic tool protocol", () =>
  Effect.gen(function* () {
    const challenges = manifest as unknown as ReadonlyArray<{
      readonly recipe: ReadonlyArray<{
        readonly tool: string;
        readonly params: unknown;
      }>;
    }>;
    const recipes = challenges
      .flatMap((challenge) => challenge.recipe)
      .filter((step) => step.tool.startsWith("chrome_"));
    yield* Effect.forEach(
      recipes,
      (step) => {
        const params = step.params as Readonly<Record<string, unknown>>;
        const ref = params.ref;
        const normalizedParams =
          typeof ref === "string" && ref.startsWith("$ACTION_REF(")
            ? { ...params, ref: "el-1" }
            : ref === "$CONTENT_FRONTIER" ||
                (typeof ref === "string" && ref.startsWith("$ACTION_FRONTIER("))
              ? { ...params, ref: "frontier-1" }
              : params;
        return decodeAtomicToolRequest(step.tool, normalizedParams);
      },
      { discard: true },
    );
    const generated = new Set(ATOMIC_TOOL_DESCRIPTORS.map(({ name }) => name));
    expect(recipes.every((step) => generated.has(step.tool as `chrome_${string}`))).toBe(true);
    expect(recipes.some((step) => step.tool === "chrome_snapshot")).toBe(true);
    expect(recipes.some((step) => step.tool === "chrome_click")).toBe(true);
  }),
);

it("reserves result-delivery time beyond every browser execution budget", () => {
  const commands = [
    { domain: "tab", call: { op: "list" } },
    {
      domain: "page",
      call: {
        operation: {
          kind: "navigate",
          url: "https://example.test",
          timeoutMs: 1_000,
        },
      },
    },
    {
      domain: "page",
      call: {
        operation: {
          kind: "screenshot",
          format: "png",
          capture: { kind: "full-page-tiles" },
        },
      },
    },
    {
      domain: "input",
      call: { operation: { kind: "type", text: "x".repeat(500) } },
    },
  ] as const;

  for (const command of commands) {
    expect(bridgeDeliveryTimeoutMs(command)).toBe(
      browserExecutionTimeoutMs(command) + RESULT_DELIVERY_GRACE_MS,
    );
  }
  expect(browserExecutionTimeoutMs(commands[3])).toBe(120_000);
});

it("derives the fixed extension package id from the manifest public key", () => {
  expect(extensionPackageIdFromPublicKey(EXTENSION_PUBLIC_KEY)).toBe(EXTENSION_PACKAGE_ID);
  expect(EXTENSION_PACKAGE_ID).toMatch(/^[a-p]{32}$/);
  expect(browserManifest).not.toHaveProperty("key");
});
