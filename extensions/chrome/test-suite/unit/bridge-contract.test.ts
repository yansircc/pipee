import { expect, it } from "@effect/vitest";
import {
  BRIDGE_ALLOWED_METHODS,
  BRIDGE_ROUTES,
  COMMAND_DEADLINES_MS,
  CONNECTOR_LEASE_DEADLINE_MS,
  CONNECTOR_REQUEST_DEADLINE_MS,
  INCOMING_CONNECTION_LIMIT,
  INCOMING_HEADERS_DEADLINE_MS,
  INCOMING_REQUEST_DEADLINE_MS,
  HMAC_AUTHENTICATION,
  AUTHENTICATION_CHALLENGE_DEADLINE_MS,
  OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS,
  OWNER_REQUEST_DEADLINE_MS,
  PENDING_CHALLENGE_LIMIT,
  POLL_WAIT_DEADLINE_MS,
  REQUEST_BODY_BYTE_LIMIT,
  RESULT_DELIVERY_POLICY,
  SCREENSHOT_LIMITS,
  SCREENSHOT_PAYLOAD_BYTE_LIMIT,
  classifyResultDelivery,
  isOwnerBridgeRouteName,
  matchesBridgeRoute,
  requestBodyLimitForRoute,
  resolveBridgeRoute,
  responseBodyLimitForRoute,
  type BridgeRouteName,
  type ResultDeliveryPolicy,
} from "../../src/protocol/bridge-contract.js";
import {
  bridgeDeliveryTimeoutMs,
  browserExecutionTimeoutMs,
  type CommandDeadlinePolicy,
} from "../../src/protocol/timeout.js";

it("derives route matching, owner authorization, and CORS methods from one route table", () => {
  const routeEntries = Object.entries(BRIDGE_ROUTES) as ReadonlyArray<
    [BridgeRouteName, (typeof BRIDGE_ROUTES)[BridgeRouteName]]
  >;
  const applicationKeys = routeEntries
    .filter(([name]) => name !== "preflight")
    .map(([, route]) => `${route.method} ${route.path}`);
  expect(new Set(applicationKeys).size).toBe(applicationKeys.length);

  for (const [name, route] of routeEntries) {
    expect(matchesBridgeRoute(name, route.method, route.path === "*" ? "/any" : route.path)).toBe(
      true,
    );
    expect(isOwnerBridgeRouteName(name)).toBe(route.authorization === "owner");
    expect(resolveBridgeRoute(route.method, route.path === "*" ? "/any" : route.path)).toEqual({
      _tag: "Matched",
      name,
    });
    expect(Number.isSafeInteger(requestBodyLimitForRoute(name))).toBe(true);
    expect(requestBodyLimitForRoute(name)).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(responseBodyLimitForRoute(name))).toBe(true);
    expect(responseBodyLimitForRoute(name)).toBeGreaterThan(0);
  }
  expect(new Set(BRIDGE_ALLOWED_METHODS.split(","))).toEqual(
    new Set(routeEntries.map(([, route]) => route.method)),
  );
});

it("keeps every transport deadline positive and the connector beyond the poll wait", () => {
  expect(OWNER_REQUEST_DEADLINE_MS).toBeGreaterThan(0);
  expect(OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS).toBeGreaterThan(0);
  expect(POLL_WAIT_DEADLINE_MS).toBeGreaterThan(0);
  expect(CONNECTOR_REQUEST_DEADLINE_MS).toBeGreaterThan(POLL_WAIT_DEADLINE_MS);
  expect(CONNECTOR_LEASE_DEADLINE_MS).toBeGreaterThan(POLL_WAIT_DEADLINE_MS);
  expect(CONNECTOR_LEASE_DEADLINE_MS).toBeGreaterThan(CONNECTOR_REQUEST_DEADLINE_MS);
  expect(INCOMING_REQUEST_DEADLINE_MS).toBeGreaterThan(POLL_WAIT_DEADLINE_MS);
  expect(INCOMING_REQUEST_DEADLINE_MS).toBeGreaterThanOrEqual(CONNECTOR_REQUEST_DEADLINE_MS);
  expect(INCOMING_HEADERS_DEADLINE_MS).toBeLessThanOrEqual(INCOMING_REQUEST_DEADLINE_MS);
  expect(AUTHENTICATION_CHALLENGE_DEADLINE_MS).toBeGreaterThan(0);
  expect(INCOMING_CONNECTION_LIMIT).toBeGreaterThan(0);
  expect(PENDING_CHALLENGE_LIMIT).toBeGreaterThan(0);
  expect(REQUEST_BODY_BYTE_LIMIT).toBeGreaterThan(SCREENSHOT_PAYLOAD_BYTE_LIMIT);
  expect(requestBodyLimitForRoute("connectorHandshake")).toBeLessThan(REQUEST_BODY_BYTE_LIMIT);
  expect(responseBodyLimitForRoute("ownerHandshake")).toBeLessThan(
    responseBodyLimitForRoute("command"),
  );
  expect(HMAC_AUTHENTICATION.algorithmVersion).toBeGreaterThan(0);
  expect(HMAC_AUTHENTICATION.digest).toBe("sha256");
  expect(SCREENSHOT_LIMITS.maxCapturePixels).toBeGreaterThan(0);
  expect(Object.values(COMMAND_DEADLINES_MS).every((deadline) => deadline > 0)).toBe(true);
});

it("projects every command execution and delivery deadline field into behavior", () => {
  const tab = { domain: "tab", call: { op: "list" } } as const;
  const navigate = {
    domain: "page",
    call: { operation: { kind: "navigate", url: "https://example.test" } },
  } as const;
  const fullPage = {
    domain: "page",
    call: {
      operation: {
        kind: "screenshot",
        format: "png",
        capture: { kind: "full-page-tiles" },
      },
    },
  } as const;
  const wait = {
    domain: "page",
    call: {
      operation: {
        kind: "wait",
        condition: { by: "selector", value: "#ready" },
        timeoutMs: 120_000,
      },
    },
  } as const;
  const emptyText = {
    domain: "input",
    call: { operation: { kind: "type", text: "" } },
  } as const;
  const oneCharacter = {
    domain: "input",
    call: { operation: { kind: "type", text: "x" } },
  } as const;
  const longText = {
    domain: "input",
    call: { operation: { kind: "type", text: "x".repeat(10_000) } },
  } as const;
  const withPolicy = (
    field: keyof CommandDeadlinePolicy,
    value: number,
  ): CommandDeadlinePolicy => ({ ...COMMAND_DEADLINES_MS, [field]: value });

  expect(
    browserExecutionTimeoutMs(
      tab,
      withPolicy("defaultExecution", COMMAND_DEADLINES_MS.defaultExecution + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.defaultExecution + 1);
  expect(
    browserExecutionTimeoutMs(
      navigate,
      withPolicy("navigateDefault", COMMAND_DEADLINES_MS.navigateDefault + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.navigateDefault + 1 + COMMAND_DEADLINES_MS.navigateOverhead);
  expect(
    browserExecutionTimeoutMs(
      navigate,
      withPolicy("navigateOverhead", COMMAND_DEADLINES_MS.navigateOverhead + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.navigateDefault + COMMAND_DEADLINES_MS.navigateOverhead + 1);
  expect(
    browserExecutionTimeoutMs(
      fullPage,
      withPolicy("fullPageScreenshot", COMMAND_DEADLINES_MS.fullPageScreenshot + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.fullPageScreenshot + 1);
  expect(browserExecutionTimeoutMs(wait)).toBe(
    120_000 + COMMAND_DEADLINES_MS.waitIntervalDefault + COMMAND_DEADLINES_MS.waitOverhead,
  );
  expect(
    browserExecutionTimeoutMs(
      wait,
      withPolicy("waitOverhead", COMMAND_DEADLINES_MS.waitOverhead + 1),
    ),
  ).toBe(
    120_000 + COMMAND_DEADLINES_MS.waitIntervalDefault + COMMAND_DEADLINES_MS.waitOverhead + 1,
  );
  expect(
    browserExecutionTimeoutMs(
      emptyText,
      withPolicy("textInputBase", COMMAND_DEADLINES_MS.textInputBase + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.textInputBase + 1);
  expect(
    browserExecutionTimeoutMs(
      oneCharacter,
      withPolicy("textInputPerCharacter", COMMAND_DEADLINES_MS.textInputPerCharacter + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.textInputBase + COMMAND_DEADLINES_MS.textInputPerCharacter + 1);
  expect(
    browserExecutionTimeoutMs(
      longText,
      withPolicy("textInputMaximum", COMMAND_DEADLINES_MS.textInputMaximum + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.textInputMaximum + 1);
  expect(
    bridgeDeliveryTimeoutMs(
      tab,
      withPolicy("resultDeliveryGrace", COMMAND_DEADLINES_MS.resultDeliveryGrace + 1),
    ),
  ).toBe(COMMAND_DEADLINES_MS.defaultExecution + COMMAND_DEADLINES_MS.resultDeliveryGrace + 1);
});

it("classifies result delivery only from the owned status policy", () => {
  expect(classifyResultDelivery(199)).toBe("blocked");
  expect(classifyResultDelivery(200)).toBe("terminal");
  expect(classifyResultDelivery(204)).toBe("blocked");
  expect(classifyResultDelivery(299)).toBe("blocked");
  expect(classifyResultDelivery(300)).toBe("blocked");
  expect(classifyResultDelivery(404)).toBe("terminal");
  expect(classifyResultDelivery(500)).toBe("retry");
  expect(classifyResultDelivery(599)).toBe("retry");
  expect(classifyResultDelivery(600)).toBe("blocked");
});

it("changes classification when each result policy field changes", () => {
  const classifyWith = (status: number, policy: ResultDeliveryPolicy) =>
    classifyResultDelivery(status, policy);
  expect(
    classifyWith(200, {
      ...RESULT_DELIVERY_POLICY,
      acknowledgedStatus: 201,
    }),
  ).toBe("blocked");
  expect(
    classifyWith(404, {
      ...RESULT_DELIVERY_POLICY,
      unknownCommandStatus: 405,
    }),
  ).toBe("blocked");
  expect(
    classifyWith(500, {
      ...RESULT_DELIVERY_POLICY,
      retryableRange: { ...RESULT_DELIVERY_POLICY.retryableRange, minimum: 501 },
    }),
  ).toBe("blocked");
  expect(
    classifyWith(599, {
      ...RESULT_DELIVERY_POLICY,
      retryableRange: { ...RESULT_DELIVERY_POLICY.retryableRange, maximum: 598 },
    }),
  ).toBe("blocked");
});
