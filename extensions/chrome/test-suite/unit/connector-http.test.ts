import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { connectorRequest, pairingRequest } from "../../src/browser/connector-http.js";
import { connectorServerProofMessage } from "../../src/protocol/bridge-authentication.js";
import { BRIDGE_ORIGIN, BRIDGE_ROUTES } from "../../src/protocol/bridge-contract.js";
import {
  CONNECTOR_BODY_SHA256_HEADER,
  CONNECTOR_BRIDGE_EPOCH_HEADER,
  CONNECTOR_CLIENT_NONCE_HEADER,
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_ID_HEADER,
  CONNECTOR_DISPLAY_VERSION_METADATA_HEADER,
  CONNECTOR_PROOF_HEADER,
  CONNECTOR_PROTOCOL_FINGERPRINT_HEADER,
  CONNECTOR_REQUEST_NONCE_HEADER,
} from "../../src/protocol/connector-auth.js";
import { nodeHmacProof } from "../../src/pi/bridge-authentication-node.js";

const extensionId = "a".repeat(32);

Object.assign(globalThis, {
  __PI_CHROME_BRIDGE_URL__: BRIDGE_ORIGIN,
  chrome: { runtime: { id: extensionId } },
});

const connector = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  secret: "a".repeat(64),
  label: "日常 Chrome",
  extensionId,
  extensionDisplayVersion: "0.16.0",
  protocolFingerprint: "b".repeat(64),
};

const bridgeEpoch = "c".repeat(64);
const requestNonce = "d".repeat(64);

it.effect("aborts a connector request at its explicit deadline", () =>
  Effect.gen(function* () {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );

    const request = yield* Effect.forkChild(connectorRequest("poll", {}, connector, 100));
    yield* Effect.yieldNow;
    yield* TestClock.adjust("100 millis");
    const failure = yield* Fiber.join(request).pipe(Effect.flip);

    expect(failure.code).toBe("bridge-timeout");
    expect(aborted).toBe(true);
    vi.unstubAllGlobals();
  }),
);

it.effect("keeps Unicode profile labels out of HTTP headers", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith(BRIDGE_ROUTES.connectorHandshake.path)) {
          const headers = new Headers(init.headers);
          const clientNonce = headers.get(CONNECTOR_CLIENT_NONCE_HEADER)!;
          const challenge = { bridgeEpoch, requestNonce } as const;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                bridgeDisplayVersion: "0.16.0",
                protocolFingerprint: connector.protocolFingerprint,
                ...challenge,
                proof: nodeHmacProof(
                  connector.secret,
                  connectorServerProofMessage(
                    "connectorServerProof",
                    connector,
                    clientNonce,
                    challenge,
                    connector.protocolFingerprint,
                  ),
                ),
              }),
            ),
          );
        }
        return Promise.resolve(new Response("ok"));
      }),
    );

    yield* connectorRequest("poll", {}, connector, 1_000);

    expect(requests.map(({ url }) => url)).toEqual([
      `${__PI_CHROME_BRIDGE_URL__}${BRIDGE_ROUTES.connectorHandshake.path}`,
      `${__PI_CHROME_BRIDGE_URL__}${BRIDGE_ROUTES.poll.path}`,
    ]);
    const handshakeHeaders = Object.fromEntries(new Headers(requests[0]!.init.headers).entries());
    const pollHeaders = Object.fromEntries(new Headers(requests[1]!.init.headers).entries());
    expect(handshakeHeaders).toMatchObject({
      [CONNECTOR_EXTENSION_ID_HEADER]: connector.extensionId,
      [CONNECTOR_ID_HEADER]: connector.connectorId,
      [CONNECTOR_DISPLAY_VERSION_METADATA_HEADER]: connector.extensionDisplayVersion,
      [CONNECTOR_PROTOCOL_FINGERPRINT_HEADER]: connector.protocolFingerprint,
    });
    expect(handshakeHeaders[CONNECTOR_CLIENT_NONCE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(pollHeaders).toMatchObject({
      [CONNECTOR_BRIDGE_EPOCH_HEADER]: bridgeEpoch,
      [CONNECTOR_REQUEST_NONCE_HEADER]: requestNonce,
      [CONNECTOR_BODY_SHA256_HEADER]: expect.stringMatching(/^[0-9a-f]{64}$/),
      [CONNECTOR_PROOF_HEADER]: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(requests)).not.toContain(connector.secret);
    expect(JSON.stringify(requests)).not.toContain(connector.label);
    vi.unstubAllGlobals();
  }),
);

it.effect("withholds the connector secret from an unauthenticated listener", () =>
  Effect.gen(function* () {
    const requests: Array<RequestInit> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requests.push(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              bridgeDisplayVersion: "0.16.0",
              protocolFingerprint: connector.protocolFingerprint,
              bridgeEpoch,
              requestNonce,
              proof: "0".repeat(64),
            }),
          ),
        );
      }),
    );

    const failure = yield* connectorRequest("poll", {}, connector, 1_000).pipe(Effect.flip);
    expect(failure.code).toBe("bridge-listener-authentication");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify([...new Headers(requests[0]!.headers).entries()])).not.toContain(
      connector.secret,
    );
    vi.unstubAllGlobals();
  }),
);

it.effect("withholds the pairing token and new connector secret from a rogue listener", () =>
  Effect.gen(function* () {
    const capability = "A".repeat(32);
    const requests: Array<RequestInit> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requests.push(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              bridgeDisplayVersion: "0.16.0",
              protocolFingerprint: connector.protocolFingerprint,
              bridgeEpoch,
              requestNonce,
              proof: "0".repeat(64),
            }),
          ),
        );
      }),
    );

    const failure = yield* pairingRequest(
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ connector }) },
      connector,
      capability,
      undefined,
      1_000,
    ).pipe(Effect.flip);
    expect(failure.code).toBe("bridge-listener-authentication");
    expect(requests).toHaveLength(1);
    const serialized = JSON.stringify({
      headers: [...new Headers(requests[0]!.headers).entries()],
      body: requests[0]!.body,
    });
    expect(serialized).not.toContain(capability);
    expect(serialized).not.toContain(connector.secret);
    vi.unstubAllGlobals();
  }),
);

it.effect("sends the new connector only after the pairing listener proves the token", () =>
  Effect.gen(function* () {
    const capability = "A".repeat(32);
    const requests: Array<RequestInit> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        requests.push(init);
        if (url.endsWith(BRIDGE_ROUTES.pairingHandshake.path)) {
          const clientNonce = new Headers(init.headers).get(CONNECTOR_CLIENT_NONCE_HEADER)!;
          const challenge = { bridgeEpoch, requestNonce } as const;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                bridgeDisplayVersion: "0.16.0",
                protocolFingerprint: connector.protocolFingerprint,
                ...challenge,
                proof: nodeHmacProof(
                  capability,
                  connectorServerProofMessage(
                    "pairingServerProof",
                    connector,
                    clientNonce,
                    challenge,
                    connector.protocolFingerprint,
                  ),
                ),
              }),
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }),
    );

    yield* pairingRequest(
      { headers: { "content-type": "application/json" }, body: JSON.stringify({ connector }) },
      connector,
      capability,
      undefined,
      1_000,
    );

    expect(requests).toHaveLength(2);
    const handshake = JSON.stringify({
      headers: [...new Headers(requests[0]!.headers).entries()],
      body: requests[0]!.body,
    });
    expect(handshake).not.toContain(capability);
    expect(handshake).not.toContain(connector.secret);
    const confirmationBody = requests[1]!.body;
    expect(typeof confirmationBody).toBe("string");
    expect(confirmationBody).toContain(connector.secret);
    expect(JSON.stringify([...new Headers(requests[1]!.headers).entries()])).not.toContain(
      capability,
    );
    vi.unstubAllGlobals();
  }),
);
