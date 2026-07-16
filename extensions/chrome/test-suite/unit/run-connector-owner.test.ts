import { expect, it } from "vite-plus/test";
import type { SessionWebRouteStatus, WebRunLeaseClaim } from "../../src/protocol/schema.js";
import { RunConnectorOwner } from "../../src/pi/run-connector-owner.js";
import type { SessionScope } from "../../src/pi/session-runtime-owner.js";

const scope = (key: string): SessionScope =>
  ({
    epoch: 1,
    context: {},
    sessionManager: {},
    identity: { key, groupTitle: key },
    capability: {},
  }) as SessionScope;

const lease = (pairingId: string, connectorId: string, sessionKey: string): WebRunLeaseClaim => ({
  pairingId,
  connectorId,
  sessionKey,
  leaseToken: pairingId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
});

const publicConnector = (connectorId: string) => ({
  connectorId,
  label: "Web profile",
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
});

it("activates one committed web route for the whole settled run", () => {
  const owner = new RunConnectorOwner();
  const session = scope("session:web");
  const first = lease(
    "11111111-1111-4111-8111-111111111111",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session.identity.key,
  );

  expect(owner.admit(session)).toBe(true);
  expect(owner.prepare(session, first)).toEqual([]);
  expect(owner.assertPrepared(session, first.pairingId)).toEqual(first);
  expect(owner.commitPrepared(session, first.pairingId)).toBe(true);

  const activation = owner.activate(session);
  expect(activation._tag).toBe("Activated");
  if (activation._tag !== "Activated") return;
  expect(activation.claim.selection).toEqual({ source: "web", claim: first });
  expect(owner.activate(session)).toEqual({ _tag: "Activated", claim: activation.claim });
  expect(owner.validates(activation.claim)).toBe(true);

  expect(owner.settle(session)).toBe(true);
  expect(owner.claim(session)).toBeUndefined();
  expect(owner.validates(activation.claim)).toBe(false);

  const next = owner.activate(session);
  expect(next._tag).toBe("Activated");
  if (next._tag !== "Activated") return;
  expect(next.claim.selection).toEqual({ source: "web", claim: first });
  expect(next.claim.generation).not.toBe(activation.claim.generation);
});

it("keeps an expired Web route unavailable instead of selecting Terminal", () => {
  const owner = new RunConnectorOwner();
  const session = scope("session:web");
  const connectorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const route = {
    source: "web",
    sessionKey: session.identity.key,
    generation: "11111111-1111-4111-8111-111111111111",
    connector: publicConnector(connectorId),
    availability: "expired",
    connected: false,
  } satisfies SessionWebRouteStatus;

  expect(owner.admit(session)).toBe(true);
  expect(owner.restoreWeb(session, route)).toBe(true);
  expect(owner.selection(session)).toBeUndefined();
  expect(owner.activate(session)).toEqual({
    _tag: "Unavailable",
    connectorId,
    routeGeneration: route.generation,
  });

  expect(owner.attachTerminal(session, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(true);
  expect(owner.activate(session)).toMatchObject({
    _tag: "Activated",
    claim: {
      selection: {
        source: "terminal",
        expectedConnectorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    },
  });
});

it("invalidates pre-admission claims when a new route generation commits", () => {
  const owner = new RunConnectorOwner();
  const session = scope("session:web");
  const first = lease(
    "11111111-1111-4111-8111-111111111111",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session.identity.key,
  );
  const second = lease(
    "22222222-2222-4222-8222-222222222222",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    session.identity.key,
  );

  expect(owner.admit(session)).toBe(true);
  expect(owner.prepare(session, first)).toEqual([]);
  expect(owner.commitPrepared(session, first.pairingId)).toBe(true);
  const firstActivation = owner.activate(session);
  expect(firstActivation._tag).toBe("Activated");
  if (firstActivation._tag !== "Activated") return;

  expect(owner.prepare(session, second)).toEqual([]);
  expect(owner.validates(firstActivation.claim)).toBe(true);
  expect(owner.commitPrepared(session, second.pairingId)).toBe(true);
  expect(owner.validates(firstActivation.claim)).toBe(false);

  expect(owner.settle(session)).toBe(true);
  expect(owner.activate(session)).toMatchObject({
    _tag: "Activated",
    claim: { selection: { source: "web", claim: second } },
  });
});

it("returns replaced staged leases once and detaches the committed generation", () => {
  const owner = new RunConnectorOwner();
  const session = scope("session:web");
  const foreign = scope("session:foreign");
  const first = lease(
    "11111111-1111-4111-8111-111111111111",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session.identity.key,
  );
  const second = lease(
    "22222222-2222-4222-8222-222222222222",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    session.identity.key,
  );

  expect(owner.admit(session)).toBe(true);
  expect(owner.prepare(foreign, first)).toBeUndefined();
  expect(owner.prepare(session, first)).toEqual([]);
  expect(owner.prepare(session, second)).toEqual([first]);
  expect(owner.commitPrepared(session, second.pairingId)).toBe(true);
  expect(owner.detach(session, second.pairingId)).toEqual({
    generation: second.pairingId,
    claim: second,
  });
  expect(owner.activate(session)).toEqual({ _tag: "Detached" });
  expect(owner.begin()).toEqual([]);
});

it("keeps the old route until a staged replacement commits", () => {
  const owner = new RunConnectorOwner();
  const session = scope("session:web");
  const first = lease(
    "11111111-1111-4111-8111-111111111111",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session.identity.key,
  );
  const second = lease(
    "22222222-2222-4222-8222-222222222222",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    session.identity.key,
  );

  expect(owner.admit(session)).toBe(true);
  expect(owner.prepare(session, first)).toEqual([]);
  expect(owner.commitPrepared(session, first.pairingId)).toBe(true);

  expect(owner.prepare(session, second)).toEqual([]);
  expect(owner.selection(session)).toEqual({ source: "web", claim: first });
  expect(owner.detach(session, second.pairingId)).toEqual({
    generation: second.pairingId,
    claim: second,
  });
  expect(owner.selection(session)).toEqual({ source: "web", claim: first });

  expect(owner.prepare(session, second)).toEqual([]);
  expect(owner.commitPrepared(session, second.pairingId)).toBe(true);
  expect(owner.selection(session)).toEqual({ source: "web", claim: second });
  expect(owner.detach(session, second.pairingId)).toEqual({
    generation: second.pairingId,
    claim: second,
  });
  expect(owner.activate(session)).toEqual({ _tag: "Detached" });
});
