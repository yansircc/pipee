import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type {
  ConnectorRouteIdentity,
  ProfileConnector,
  WireCommand,
} from "../../src/protocol/schema.js";
import { SmokeCommandScenario } from "./fake-bridge-scenario.ts";
import {
  BRIDGE_ALLOWED_METHODS,
  BRIDGE_HOST,
  BRIDGE_PORT,
  CONNECTOR_HEADERS,
  CONNECTOR_METADATA_HEADERS,
  CONNECTOR_REQUEST_HEADERS,
  type BridgeRequestChallenge,
  connectorRequestProofMessage,
  connectorServerProofMessage,
  decodePairingConnector,
  hashBridgeRequestBody,
  hmacProof,
  matchesRoute,
  proofMatches,
  SMOKE_ROUTES,
} from "./protocol-fixture.ts";
import { deferred, errorOf, SmokeFailure, withTimeout, type Deferred } from "./support.ts";

const CONNECTOR_ID_HEADER = CONNECTOR_HEADERS.id;
const CONNECTOR_EXTENSION_ID_HEADER = CONNECTOR_HEADERS.extensionId;
const CONNECTOR_CLIENT_NONCE_HEADER = CONNECTOR_HEADERS.clientNonce;
const CONNECTOR_BRIDGE_EPOCH_HEADER = CONNECTOR_HEADERS.bridgeEpoch;
const CONNECTOR_REQUEST_NONCE_HEADER = CONNECTOR_HEADERS.requestNonce;
const CONNECTOR_BODY_SHA256_HEADER = CONNECTOR_HEADERS.bodySha256;
const CONNECTOR_PROOF_HEADER = CONNECTOR_HEADERS.proof;
const CONNECTOR_DISPLAY_VERSION_METADATA_HEADER = CONNECTOR_METADATA_HEADERS.displayVersion;
const CONNECTOR_PROTOCOL_FINGERPRINT_HEADER = CONNECTOR_METADATA_HEADERS.protocolFingerprint;

type ObservedConnector = ConnectorRouteIdentity & {
  readonly runtimeOrigin: string;
  readonly transportOrigin?: string;
};

export type BoundSmokeConnector = ProfileConnector & {
  readonly runtimeOrigin: string;
  readonly transportOrigin?: string;
};

type PendingChallenge = {
  readonly kind: "connector" | "pairing";
  readonly identity: ConnectorRouteIdentity;
};

const hexToken = (bytes: number): string => randomBytes(bytes).toString("hex");

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });

const writeJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

const header = (request: IncomingMessage, name: string): string =>
  String(request.headers[name] ?? "");

const assertNotTransmitted = (
  request: IncomingMessage,
  secret: string,
  body: string = "",
): void => {
  assert.equal(
    JSON.stringify(request.headers).includes(secret),
    false,
    "Secret crossed HTTP headers",
  );
  assert.equal(body.includes(secret), false, "Secret crossed an authenticated HTTP body");
};

const sameIdentity = (left: ConnectorRouteIdentity, right: ConnectorRouteIdentity): boolean =>
  left.connectorId === right.connectorId &&
  left.extensionId === right.extensionId &&
  left.extensionDisplayVersion === right.extensionDisplayVersion &&
  left.protocolFingerprint === right.protocolFingerprint;

export class FakeBridge {
  readonly pairingCapability = randomBytes(16).toString("hex").toUpperCase();
  readonly identityReady: Deferred<BoundSmokeConnector> = deferred();
  readonly restartIdentityReady: Deferred<ConnectorRouteIdentity> = deferred();
  readonly unpairedReady: Deferred<ObservedConnector> = deferred();
  readonly pairingReady = deferred();
  readonly invalidServerProofRejected = deferred();
  readonly failure: Deferred<never> = deferred();
  readonly expectedExtensionId: string;
  readonly expectedExtensionDisplayVersion: string;

  expectedProtocolFingerprint: string | undefined;
  identity: BoundSmokeConnector | undefined;
  url = "";
  port = 0;

  private readonly expectedOrigin: string;
  private readonly bridgeEpoch = hexToken(32);
  private readonly pendingChallenges = new Map<string, PendingChallenge>();
  private readonly rejections = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly scenario: SmokeCommandScenario;
  private unpairedIdentity: ObservedConnector | undefined;
  private unpairedAttempts = 0;
  private awaitingRestartIdentity = false;
  private invalidServerProofArmed = false;
  private invalidServerProofNonce: string | undefined;

  constructor(expectedExtensionId: string, expectedExtensionDisplayVersion: string) {
    this.expectedExtensionId = expectedExtensionId;
    this.expectedExtensionDisplayVersion = expectedExtensionDisplayVersion;
    this.expectedOrigin = `chrome-extension://${expectedExtensionId}`;
    this.scenario = new SmokeCommandScenario(
      expectedExtensionDisplayVersion,
      () => {
        assert(this.expectedProtocolFingerprint, "Smoke protocol fingerprint is not initialized");
        return this.expectedProtocolFingerprint;
      },
      writeJson,
    );
    this.failure.promise.catch(() => undefined);
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((cause) => {
        const error = errorOf(cause, "Fake bridge request failed");
        this.failure.reject(error);
        if (!response.headersSent) writeJson(response, 500, { ok: false, error: error.message });
        else response.destroy(error);
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  setCommands(commands: ReadonlyArray<WireCommand>): void {
    this.scenario.setCommands(commands);
  }

  expectWorkerRestartIdentity(): void {
    assert.equal(this.awaitingRestartIdentity, false);
    this.awaitingRestartIdentity = true;
  }

  armFingerprintMismatch(): void {
    this.scenario.armFingerprintMismatch();
  }

  armInvalidServerProof(): void {
    assert.equal(this.invalidServerProofArmed, false);
    this.invalidServerProofArmed = true;
  }

  releaseCommandDelivery(): void {
    this.scenario.releaseCommandDelivery();
  }

  releaseResultDelivery(): void {
    this.scenario.releaseResultDelivery();
  }

  get commandReady() {
    return this.scenario.commandReady;
  }

  get resultReady() {
    return this.scenario.resultReady;
  }

  get allResultsReady() {
    return this.scenario.allResultsReady;
  }

  get fingerprintMismatchReady() {
    return this.scenario.fingerprintMismatchReady;
  }

  get pollAfterAcknowledgement() {
    return this.scenario.pollAfterAcknowledgement;
  }

  get commandDeliveryReleased(): boolean {
    return this.scenario.commandDeliveryReleased;
  }

  get nextCommandIndex(): number {
    return this.scenario.nextCommandIndex;
  }

  get currentCommand(): WireCommand | undefined {
    return this.scenario.currentCommand;
  }

  get incompatibleResultAttempts(): number {
    return this.scenario.incompatibleResultAttempts;
  }

  get resultAttempts(): ReadonlyMap<string, number> {
    return this.scenario.resultAttempts;
  }

  get results() {
    return this.scenario.results;
  }

  async listen(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(port, BRIDGE_HOST, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    assert(address && typeof address === "object", "Fake bridge did not expose a TCP address");
    if (port === 0) {
      assert.notEqual(
        address.port,
        BRIDGE_PORT,
        `Ephemeral bridge selected production port ${BRIDGE_PORT}`,
      );
    } else {
      assert.equal(address.port, port, "Fake bridge did not bind the requested candidate port");
    }
    this.port = address.port;
    this.url = `http://${BRIDGE_HOST}:${address.port}`;
  }

  waitFor<Value>(promise: Promise<Value>, label: string, timeoutMs: number): Promise<Value> {
    return withTimeout(Promise.race([promise, this.failure.promise]), label, timeoutMs);
  }

  private cors(origin: string): Record<string, string> {
    return origin === this.expectedOrigin
      ? {
          "access-control-allow-origin": this.expectedOrigin,
          "access-control-allow-methods": BRIDGE_ALLOWED_METHODS,
          "access-control-allow-headers": CONNECTOR_REQUEST_HEADERS,
          "access-control-allow-private-network": "true",
          vary: "origin",
        }
      : {};
  }

  private readIdentity(request: IncomingMessage): ObservedConnector {
    const extensionId = header(request, CONNECTOR_EXTENSION_ID_HEADER);
    const transportOrigin =
      typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    return {
      connectorId: header(request, CONNECTOR_ID_HEADER),
      extensionId,
      extensionDisplayVersion: header(request, CONNECTOR_DISPLAY_VERSION_METADATA_HEADER),
      protocolFingerprint: header(request, CONNECTOR_PROTOCOL_FINGERPRINT_HEADER),
      runtimeOrigin: `chrome-extension://${extensionId}`,
      ...(transportOrigin === undefined ? {} : { transportOrigin }),
    };
  }

  private assertExpectedPackage(identity: ObservedConnector): void {
    assert.equal(identity.extensionId, this.expectedExtensionId);
    assert.equal(identity.runtimeOrigin, this.expectedOrigin);
    assert.equal(identity.extensionDisplayVersion, this.expectedExtensionDisplayVersion);
    assert.match(identity.connectorId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.match(identity.protocolFingerprint, /^[0-9a-f]{64}$/);
    if (identity.transportOrigin !== undefined) {
      assert.equal(identity.transportOrigin, this.expectedOrigin);
    }
    if (this.expectedProtocolFingerprint === undefined) {
      this.expectedProtocolFingerprint = identity.protocolFingerprint;
    } else {
      assert.equal(identity.protocolFingerprint, this.expectedProtocolFingerprint);
    }
  }

  private observeUnpairedIdentity(identity: ObservedConnector): void {
    this.assertExpectedPackage(identity);
    if (this.unpairedIdentity === undefined) this.unpairedIdentity = Object.freeze(identity);
    else
      assert(sameIdentity(identity, this.unpairedIdentity), "Unpaired connector identity changed");
    this.unpairedAttempts += 1;
    if (this.unpairedAttempts >= 2) this.unpairedReady.resolve(this.unpairedIdentity);
  }

  private issueChallenge(
    kind: PendingChallenge["kind"],
    identity: ConnectorRouteIdentity,
  ): BridgeRequestChallenge {
    let requestNonce = hexToken(32);
    while (this.pendingChallenges.has(requestNonce)) requestNonce = hexToken(32);
    this.pendingChallenges.set(requestNonce, { kind, identity });
    return { bridgeEpoch: this.bridgeEpoch, requestNonce };
  }

  private handleHandshake(
    request: IncomingMessage,
    response: ServerResponse,
    kind: PendingChallenge["kind"],
    cors: Readonly<Record<string, string>>,
  ): void {
    const identity = this.readIdentity(request);
    if (kind === "pairing") assertNotTransmitted(request, this.pairingCapability);
    else if (this.identity) assertNotTransmitted(request, this.identity.secret);
    if (
      identity.transportOrigin !== undefined &&
      identity.transportOrigin !== this.expectedOrigin
    ) {
      writeJson(response, 403, { ok: false, error: "origin" }, cors);
      return;
    }
    if (kind === "connector" && this.identity === undefined) {
      this.observeUnpairedIdentity(identity);
      writeJson(response, 401, { ok: false, error: "unpaired" }, cors);
      return;
    }
    this.assertExpectedPackage(identity);
    const boundIdentity = this.identity;
    if (kind === "connector" && (!boundIdentity || !sameIdentity(identity, boundIdentity))) {
      this.rejections.add("handshake:identity");
      writeJson(response, 401, { ok: false, error: "connector" }, cors);
      return;
    }
    const clientNonce = header(request, CONNECTOR_CLIENT_NONCE_HEADER);
    if (!/^[0-9a-f]{64}$/i.test(clientNonce)) {
      writeJson(response, 400, { ok: false, error: "client nonce" }, cors);
      return;
    }
    if (this.invalidServerProofNonce !== undefined) {
      this.pendingChallenges.delete(this.invalidServerProofNonce);
      this.invalidServerProofNonce = undefined;
      this.invalidServerProofRejected.resolve();
    }
    const challenge = this.issueChallenge(kind, identity);
    const serverDomain = kind === "connector" ? "connectorServerProof" : "pairingServerProof";
    const secret = kind === "connector" ? boundIdentity!.secret : this.pairingCapability;
    const message = connectorServerProofMessage(
      serverDomain,
      identity,
      clientNonce,
      challenge,
      this.expectedProtocolFingerprint!,
    );
    let proof = hmacProof(secret, message);
    if (kind === "connector" && this.invalidServerProofArmed) {
      this.invalidServerProofArmed = false;
      this.invalidServerProofNonce = challenge.requestNonce;
      proof = "0".repeat(64);
    }
    writeJson(
      response,
      200,
      {
        bridgeDisplayVersion: this.expectedExtensionDisplayVersion,
        protocolFingerprint: this.expectedProtocolFingerprint,
        ...challenge,
        proof,
      },
      cors,
    );
  }

  private authenticateRequest(
    request: IncomingMessage,
    routeName: "pairingConfirm" | "poll" | "result",
    kind: PendingChallenge["kind"],
    secret: string,
    body: string,
  ):
    | { readonly ok: true; readonly identity: ObservedConnector }
    | {
        readonly ok: false;
        readonly status: number;
        readonly error: string;
      } {
    const identity = this.readIdentity(request);
    if (
      identity.transportOrigin !== undefined &&
      identity.transportOrigin !== this.expectedOrigin
    ) {
      return { ok: false, status: 403, error: "origin" };
    }
    const requestNonce = header(request, CONNECTOR_REQUEST_NONCE_HEADER);
    const pending = this.pendingChallenges.get(requestNonce);
    const bodyHash = header(request, CONNECTOR_BODY_SHA256_HEADER);
    const challenge = {
      bridgeEpoch: header(request, CONNECTOR_BRIDGE_EPOCH_HEADER),
      requestNonce,
    };
    const route = SMOKE_ROUTES[routeName];
    const message = connectorRequestProofMessage(
      kind === "connector" ? "connectorRequestProof" : "pairingRequestProof",
      identity,
      challenge,
      route.method,
      route.path,
      bodyHash,
    );
    const proof = header(request, CONNECTOR_PROOF_HEADER);
    if (kind === "pairing") assertNotTransmitted(request, this.pairingCapability, body);
    else assertNotTransmitted(request, secret, body);
    if (
      challenge.bridgeEpoch !== this.bridgeEpoch ||
      pending?.kind !== kind ||
      !sameIdentity(identity, pending.identity) ||
      !proofMatches(secret, message, proof)
    ) {
      this.rejections.add(`${routeName}:proof`);
      return { ok: false, status: 401, error: "proof" };
    }
    this.pendingChallenges.delete(requestNonce);
    if (hashBridgeRequestBody(body) !== bodyHash) {
      this.rejections.add(`${routeName}:body`);
      return { ok: false, status: 401, error: "body hash" };
    }
    if (this.invalidServerProofNonce === requestNonce) {
      throw new SmokeFailure("Connector trusted an invalid bridge server proof");
    }
    return { ok: true, identity };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const origin = String(request.headers.origin ?? "");
    const cors = this.cors(origin);

    if (request.method === "OPTIONS") {
      response.writeHead(origin === this.expectedOrigin ? 200 : 403, cors);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/smoke-page") {
      const second = url.searchParams.get("source") === "second";
      const name = second ? "Second" : "First";
      const code = second ? "BETA-SMOKE" : "ALPHA-SMOKE";
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        `<!doctype html><title>Pi Chrome Smoke ${name}</title><nav><button id="smoke-action" onclick="this.textContent='Clicked';document.body.dataset.clicked='true'">Metrics</button><button>Keywords</button><button>Export</button></nav><main><article><h1><a href="https://${name.toLowerCase()}.example.test/report">${name} research result</a></h1><p>${name} research code: <strong>${code}</strong>.</p><p>Semantic result snippet.</p></article></main>`,
      );
      return;
    }

    if (matchesRoute("connectorHandshake", request.method, url.pathname)) {
      await readBody(request);
      this.handleHandshake(request, response, "connector", cors);
      return;
    }

    if (matchesRoute("pairingHandshake", request.method, url.pathname)) {
      await readBody(request);
      this.handleHandshake(request, response, "pairing", cors);
      return;
    }

    if (matchesRoute("pairingConfirm", request.method, url.pathname)) {
      const body = await readBody(request);
      assert.equal(body.includes(this.pairingCapability), false, "Pairing token crossed HTTP");
      const authentication = this.authenticateRequest(
        request,
        "pairingConfirm",
        "pairing",
        this.pairingCapability,
        body,
      );
      if (!authentication.ok) {
        writeJson(
          response,
          authentication.status,
          { ok: false, error: authentication.error },
          cors,
        );
        return;
      }
      const connector = decodePairingConnector(body);
      assert(
        sameIdentity(connector, authentication.identity),
        "Pairing body identity differs from signed headers",
      );
      assert.equal(connector.label, "日常 Chrome Smoke");
      assert.match(connector.secret, /^[0-9a-f]{64}$/i);
      this.identity = Object.freeze({
        ...connector,
        runtimeOrigin: this.expectedOrigin,
        ...(authentication.identity.transportOrigin === undefined
          ? {}
          : { transportOrigin: authentication.identity.transportOrigin }),
      });
      this.identityReady.resolve(this.identity);
      this.pairingReady.resolve();
      const publicConnector = {
        connectorId: this.identity.connectorId,
        label: this.identity.label,
        extensionId: this.identity.extensionId,
        extensionDisplayVersion: this.identity.extensionDisplayVersion,
        protocolFingerprint: this.identity.protocolFingerprint,
      };
      writeJson(response, 200, { ok: true, connector: publicConnector }, cors);
      return;
    }

    if (matchesRoute("poll", request.method, url.pathname)) {
      const body = await readBody(request);
      const authentication = this.identity
        ? this.authenticateRequest(request, "poll", "connector", this.identity.secret, body)
        : { ok: false as const, status: 401, error: "unpaired" };
      if (!authentication.ok) {
        writeJson(
          response,
          authentication.status,
          { ok: false, error: authentication.error },
          cors,
        );
        return;
      }
      if (this.awaitingRestartIdentity) {
        this.awaitingRestartIdentity = false;
        this.restartIdentityReady.resolve(authentication.identity);
      }
      await this.scenario.handlePoll(response, cors);
      return;
    }

    if (matchesRoute("result", request.method, url.pathname)) {
      const body = await readBody(request);
      const authentication = this.identity
        ? this.authenticateRequest(request, "result", "connector", this.identity.secret, body)
        : { ok: false as const, status: 401, error: "unpaired" };
      if (!authentication.ok) {
        writeJson(
          response,
          authentication.status,
          { ok: false, error: authentication.error },
          cors,
        );
        return;
      }
      await this.scenario.handleResult(response, body, cors);
      return;
    }

    writeJson(response, 404, { ok: false, error: "not found" }, cors);
  }

  assertAuthenticationCoverage(): void {
    assert.deepEqual(
      [...this.rejections].sort((left, right) => left.localeCompare(right)),
      ["handshake:identity", "poll:proof", "result:proof"],
    );
  }

  async close(): Promise<void> {
    this.scenario.releaseWaiters();
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
