import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import {
  classifyChromeConnectorCompatibility,
  type ChromeExtensionExpectation,
} from "../protocol/chrome.js";
import { CommandBroker } from "../core/broker.js";
import {
  BridgeBindFailed,
  BridgeOwnerUnreachable,
  BridgeUnavailable,
  ProtocolFailure,
  messageOf,
  type BridgeFailure,
} from "../core/errors.js";
import {
  decodeForwardRequestJson,
  decodeWireResultJson,
  projectDomainRequest,
  toWireBridgeFailure,
  type DomainRequest,
} from "../protocol/codec.js";
import {
  INCOMING_CONNECTION_LIMIT,
  INCOMING_HEADERS_DEADLINE_MS,
  INCOMING_REQUEST_DEADLINE_MS,
  POLL_WAIT_DEADLINE_MS,
  RESULT_DELIVERY_POLICY,
  isOwnerBridgeRouteName,
  requestBodyLimitForRoute,
  resolveBridgeRoute,
  type BridgeRouteName,
  type ConnectorAuthenticatedRouteName,
  type OwnerBridgeRouteName,
} from "../protocol/bridge-contract.js";
import {
  connectorRequestProofMessage,
  connectorServerProofMessage,
  type BridgeRequestChallenge,
} from "../protocol/bridge-authentication.js";
import {
  CONNECTOR_BODY_SHA256_HEADER,
  CONNECTOR_BRIDGE_EPOCH_HEADER,
  CONNECTOR_CLIENT_NONCE_HEADER,
  CONNECTOR_PROOF_HEADER,
  CONNECTOR_REQUEST_NONCE_HEADER,
} from "../protocol/connector-auth.js";
import {
  OWNER_BODY_SHA256_HEADER,
  OWNER_BRIDGE_EPOCH_HEADER,
  OWNER_CLIENT_NONCE_HEADER,
  OWNER_PROOF_HEADER,
  OWNER_PROTOCOL_FINGERPRINT_HEADER,
  OWNER_REQUEST_NONCE_HEADER,
  type BridgeOwnerIdentity,
} from "../protocol/bridge-owner.js";
import { isHex256 } from "../protocol/hex-256.js";
import type { ProtocolFingerprintFailure } from "../protocol/protocol-fingerprint.js";
import {
  type BridgeStatusResponse,
  type ProfileConnector,
  type PublicConnector,
  type SessionContext,
  type WireDomainRequest,
} from "../protocol/schema.js";
import { ProfileConnector as ProfileConnectorSchema } from "../protocol/schema.js";
import { ConnectorOwner } from "./connector-owner.js";
import {
  BridgeOwnerCredentialFailure,
  makeBridgeOwnerCredentialStore,
  type BridgeOwnerCredentialStore,
} from "./bridge-owner-credential.js";
import { EXTENSION_PACKAGE_ID } from "./extension-package.js";
import {
  BridgeAuthenticationSession,
  hashBridgeRequestBody,
  hasValidNodeHmacProof,
  hasValidOwnerRequestProof,
  nodeHmacProof,
  ownerServerProof,
} from "./bridge-authentication-node.js";
import {
  extensionHeaders,
  hasExpectedExtensionOrigin,
  isLocalProcessRequest,
  parseBridgeRequestPath,
  readBody,
  requestFailureHttpStatus,
  writeJson,
} from "./bridge-http.js";
import {
  forwardCommandToOwner,
  handshakeWithOwner,
  statusFromOwner,
  waitForStatusFromOwner,
} from "./bridge-owner-client.js";
import {
  identifyConnectorRequest,
  identifyExtensionConnectorRequest,
} from "./connector-authentication.js";
import { nodeProtocolFingerprint } from "./node-protocol-fingerprint.js";

type BridgeRuntime =
  | { readonly mode: "stopped" }
  | { readonly mode: "client" }
  | {
      readonly mode: "server";
      readonly server: Server;
      readonly authentication: BridgeAuthenticationSession;
    }
  | { readonly mode: "closed" };

type BridgeMode = BridgeRuntime["mode"];

type AuthorizedOwnerRequest = {
  readonly expectedBodyHash: string;
};

type AuthorizedConnectorRequest = {
  readonly profile: ProfileConnector;
  readonly connector: PublicConnector;
  readonly expectedBodyHash: string;
};

export type BridgeStatus = BridgeStatusResponse;

type BridgeStartFailure =
  | BridgeBindFailed
  | BridgeOwnerUnreachable
  | BridgeUnavailable
  | BridgeOwnerCredentialFailure
  | ProtocolFingerprintFailure
  | ProtocolFailure;

const publicConnector = (connector: ProfileConnector): PublicConnector => ({
  connectorId: connector.connectorId,
  label: connector.label,
  extensionId: connector.extensionId,
  extensionDisplayVersion: connector.extensionDisplayVersion,
  protocolFingerprint: connector.protocolFingerprint,
});

const provideNode = <A, E>(effect: Effect.Effect<A, E, NodeServices>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));
const effectRuntime = ManagedRuntime.make(Layer.empty);

const connectorProofHeaders = (request: IncomingMessage) => ({
  bridgeEpoch: String(request.headers[CONNECTOR_BRIDGE_EPOCH_HEADER] ?? ""),
  requestNonce: String(request.headers[CONNECTOR_REQUEST_NONCE_HEADER] ?? ""),
  bodyHash: String(request.headers[CONNECTOR_BODY_SHA256_HEADER] ?? ""),
  proof: String(request.headers[CONNECTOR_PROOF_HEADER] ?? ""),
});

const ownerProofHeaders = (request: IncomingMessage) => ({
  bridgeEpoch: String(request.headers[OWNER_BRIDGE_EPOCH_HEADER] ?? ""),
  requestNonce: String(request.headers[OWNER_REQUEST_NONCE_HEADER] ?? ""),
  bodyHash: String(request.headers[OWNER_BODY_SHA256_HEADER] ?? ""),
  proof: String(request.headers[OWNER_PROOF_HEADER] ?? ""),
});

export class NodeBridge {
  private runtime: BridgeRuntime = { mode: "stopped" };

  private constructor(
    readonly host: string,
    readonly port: number,
    private readonly displayVersion: () => string,
    private readonly protocolFingerprint: string,
    private readonly credentialStore: BridgeOwnerCredentialStore,
    private readonly ownerIdentityRef: Ref.Ref<BridgeOwnerIdentity | undefined>,
    private readonly connectors: ConnectorOwner,
    private readonly broker: CommandBroker,
    private readonly lifecycleGate: Semaphore.Semaphore,
    private readonly ownership: Semaphore.Semaphore,
    private readonly readinessSignals: PubSub.PubSub<void>,
  ) {}

  static make = (host: string, port: number, displayVersion: () => string, agentDir?: string) =>
    Effect.gen(function* () {
      const protocolFingerprint = yield* nodeProtocolFingerprint;
      const broker = yield* CommandBroker.make;
      const connectors = yield* ConnectorOwner.make(broker);
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const { ownerIdentityRef, lifecycleGate, ownership, readinessSignals } = yield* Effect.all({
        ownerIdentityRef: Ref.make<BridgeOwnerIdentity | undefined>(undefined),
        lifecycleGate: Semaphore.make(1),
        ownership: Semaphore.make(1),
        readinessSignals: PubSub.sliding<void>({ capacity: 1, replay: 1 }),
      });
      return new NodeBridge(
        host,
        port,
        displayVersion,
        protocolFingerprint,
        credentialStore,
        ownerIdentityRef,
        connectors,
        broker,
        lifecycleGate,
        ownership,
        readinessSignals,
      );
    });

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  get start(): Effect.Effect<void, BridgeStartFailure> {
    return this.ownership.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (this.runtime.mode === "closed") {
          return yield* new BridgeUnavailable({
            message: "Chrome bridge is closed and cannot be restarted",
          });
        }
        if (this.runtime.mode !== "stopped") return;
        yield* this.loadOwnerIdentity;
        const mode = yield* this.bind();
        if (mode === "client") yield* this.verifyOwner;
      }),
    );
  }

  get stop(): Effect.Effect<void> {
    return this.ownership.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          const runtime = this.runtime;
          if (runtime.mode === "closed") return;
          this.runtime = { mode: "closed" };
          const closeServer =
            runtime.mode === "server"
              ? Effect.callback<void>((resume) => {
                  runtime.server.close(() => resume(Effect.void));
                  runtime.server.closeAllConnections();
                })
              : Effect.void;
          yield* Effect.all([closeServer, this.broker.stop], {
            concurrency: "unbounded",
            discard: true,
          });
        }),
      ),
    );
  }

  get status(): Effect.Effect<BridgeStatus, BridgeStartFailure | ProtocolFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) => statusFromOwner(this.url, identity)),
          Effect.catchTag("BridgeOwnerUnreachable", () =>
            this.promote.pipe(
              Effect.flatMap((mode) =>
                mode === "server"
                  ? this.localStatus
                  : this.ownerIdentity.pipe(
                      Effect.flatMap((identity) => statusFromOwner(this.url, identity)),
                    ),
              ),
            ),
          ),
        );
      }
      return this.localStatus;
    });
  }

  awaitReady(timeoutMs: number): Effect.Effect<BridgeStatus, BridgeStartFailure | ProtocolFailure> {
    const wait = Effect.suspend(() => {
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) => waitForStatusFromOwner(this.url, identity, timeoutMs + 250)),
        );
      }
      if (this.runtime.mode === "server") return this.awaitLocalReady;
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
    return wait.pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () =>
          this.status.pipe(
            Effect.flatMap((status) =>
              Effect.fail(
                new BridgeUnavailable({
                  message:
                    status.connector === undefined
                      ? `Chrome Companion did not connect within ${timeoutMs}ms`
                      : `Chrome profile ${status.connector.label} remained offline for ${timeoutMs}ms`,
                }),
              ),
            ),
          ),
      }),
    );
  }

  private get awaitLocalReady(): Effect.Effect<BridgeStatus, ProtocolFailure> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const signals = yield* PubSub.subscribe(this.readinessSignals);
        while (true) {
          const status = yield* this.localStatus;
          const connector = status.connector;
          if (connector !== undefined) {
            const compatibility = classifyChromeConnectorCompatibility(
              status.extensionExpectation,
              connector,
            );
            if (compatibility._tag === "Incompatible") {
              return yield* new ProtocolFailure({
                message: `Chrome extension is incompatible: ${compatibility.mismatches.join(", ")}`,
                cause: compatibility,
              });
            }
            if (connector.connected) return status;
          }
          yield* PubSub.take(signals);
        }
      }),
    );
  }

  send(
    request: DomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure | BridgeStartFailure> {
    return this.sendGuarded(Effect.void, request, session, timeoutMs);
  }

  sendGuarded<AdmissionError, AdmissionRequirements>(
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: DomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<
    unknown,
    BridgeFailure | BridgeStartFailure | AdmissionError,
    AdmissionRequirements
  > {
    return Effect.suspend(() => {
      const wireRequest = projectDomainRequest(request);
      if (this.runtime.mode === "server")
        return this.sendBound(admission, wireRequest, session, timeoutMs);
      if (this.runtime.mode === "client")
        return this.sendViaOwner(admission, wireRequest, session, timeoutMs);
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  private get localStatus(): Effect.Effect<BridgeStatus> {
    return Effect.gen({ self: this }, function* () {
      const connector = yield* this.connectors.current;
      const extensionExpectation = this.extensionExpectation;
      if (!connector) {
        return { url: this.url, mode: this.runtime.mode, extensionExpectation };
      }
      const status = yield* this.broker.status(connector.connectorId);
      return {
        url: this.url,
        mode: this.runtime.mode,
        extensionExpectation,
        connector: { ...publicConnector(connector), ...status },
      };
    });
  }

  private get extensionExpectation(): ChromeExtensionExpectation {
    return {
      extensionId: EXTENSION_PACKAGE_ID,
      displayVersion: this.displayVersion(),
      protocolFingerprint: this.protocolFingerprint,
    };
  }

  private get loadOwnerIdentity(): Effect.Effect<void, BridgeOwnerCredentialFailure> {
    return Effect.gen({ self: this }, function* () {
      const credential = yield* provideNode(this.credentialStore.loadOrCreate);
      yield* Ref.set(this.ownerIdentityRef, {
        credential,
        protocolFingerprint: this.protocolFingerprint,
      });
    });
  }

  private get ownerIdentity(): Effect.Effect<BridgeOwnerIdentity, BridgeUnavailable> {
    return Ref.get(this.ownerIdentityRef).pipe(
      Effect.flatMap((identity) =>
        identity
          ? Effect.succeed(identity)
          : Effect.fail(new BridgeUnavailable({ message: "Bridge owner identity is not loaded" })),
      ),
    );
  }

  private get serverAuthentication(): BridgeAuthenticationSession | undefined {
    return this.runtime.mode === "server" ? this.runtime.authentication : undefined;
  }

  private get verifyOwner(): Effect.Effect<
    void,
    BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure
  > {
    return this.ownerIdentity.pipe(
      Effect.flatMap((identity) => handshakeWithOwner(this.url, identity)),
      Effect.tapError(() =>
        Effect.sync(() => {
          this.runtime = { mode: "stopped" };
        }),
      ),
    );
  }

  private identifyOwnerRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<BridgeOwnerIdentity | undefined, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      if (!isLocalProcessRequest(request)) {
        yield* writeJson(response, 403, { ok: false, error: "owner route is local-only" });
        return undefined;
      }

      const identity = yield* Ref.get(this.ownerIdentityRef);
      if (!identity) {
        yield* writeJson(response, 503, {
          ok: false,
          error: "bridge owner identity is not loaded",
        });
        return undefined;
      }
      if (request.headers[OWNER_PROTOCOL_FINGERPRINT_HEADER] !== identity.protocolFingerprint) {
        yield* writeJson(response, 409, {
          ok: false,
          error: `bridge owner requires protocol fingerprint ${identity.protocolFingerprint}`,
          expectedProtocolFingerprint: identity.protocolFingerprint,
        });
        return undefined;
      }
      return identity;
    });
  }

  private handleOwnerHandshake(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* readBody(request, requestBodyLimitForRoute("ownerHandshake"));
      const identity = yield* this.identifyOwnerRequest(request, response);
      if (!identity) return;
      const clientNonce = String(request.headers[OWNER_CLIENT_NONCE_HEADER] ?? "");
      if (!isHex256(clientNonce)) {
        return yield* writeJson(response, 400, {
          ok: false,
          error: "owner client nonce is missing or malformed",
        });
      }
      const authentication = this.serverAuthentication;
      if (!authentication) {
        return yield* writeJson(response, 503, {
          ok: false,
          error: "bridge owner epoch is not initialized",
        });
      }
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const challenge = authentication.issue("owner", now);
      return yield* writeJson(response, 200, {
        bridgeDisplayVersion: this.displayVersion(),
        protocolFingerprint: this.protocolFingerprint,
        ...challenge,
        proof: ownerServerProof(identity, clientNonce, challenge),
      });
    });
  }

  private authorizeOwnerRequest(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Effect.Effect<AuthorizedOwnerRequest | undefined, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const identity = yield* this.identifyOwnerRequest(request, response);
      if (!identity) return undefined;
      const proofHeaders = ownerProofHeaders(request);
      const authentication = this.serverAuthentication;
      const input = {
        bridgeEpoch: proofHeaders.bridgeEpoch,
        requestNonce: proofHeaders.requestNonce,
        method: request.method ?? "",
        path,
        bodyHash: proofHeaders.bodyHash,
      };
      if (!authentication) {
        yield* writeJson(response, 503, { ok: false, error: "bridge owner is not active" });
        return undefined;
      }
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const admission = authentication.authorize("owner", proofHeaders, now);
      if (admission._tag === "Malformed") {
        yield* writeJson(response, 401, { ok: false, error: "owner request proof is invalid" });
        return undefined;
      }
      if (admission._tag === "Unavailable") {
        yield* writeJson(response, 401, {
          ok: false,
          error: "owner request challenge is unavailable, expired, or already consumed",
        });
        return undefined;
      }
      if (!hasValidOwnerRequestProof(identity, input, proofHeaders.proof)) {
        yield* writeJson(response, 401, { ok: false, error: "owner request proof is invalid" });
        return undefined;
      }
      return { expectedBodyHash: proofHeaders.bodyHash };
    });
  }

  private readOwnerBody(
    request: IncomingMessage,
    response: ServerResponse,
    routeName: Exclude<OwnerBridgeRouteName, "ownerHandshake">,
    authorization: AuthorizedOwnerRequest,
  ): Effect.Effect<string | undefined, ProtocolFailure> {
    return Effect.gen(function* () {
      const body = yield* readBody(request, requestBodyLimitForRoute(routeName));
      if (hashBridgeRequestBody(body) === authorization.expectedBodyHash) return body;
      yield* writeJson(response, 401, { ok: false, error: "owner request body hash is invalid" });
      return undefined;
    });
  }

  private identifyAuthorizedConnector(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<
    { readonly profile: ProfileConnector; readonly connector: PublicConnector } | undefined,
    ProtocolFailure
  > {
    return Effect.gen({ self: this }, function* () {
      const routeIdentity = yield* identifyExtensionConnectorRequest(request).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            writeJson(response, 401, { ok: false, error: error.message }, headers).pipe(
              Effect.as(undefined),
            ),
          onSuccess: Effect.succeed,
        }),
      );
      if (!routeIdentity) return undefined;
      const profile = yield* this.connectors.authorizedConnector(routeIdentity.connectorId);
      return yield* identifyConnectorRequest(request, profile).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            writeJson(response, 401, { ok: false, error: error.message }, headers).pipe(
              Effect.as(undefined),
            ),
          onSuccess: (connector) => Effect.succeed({ profile: profile!, connector }),
        }),
      );
    });
  }

  private handleConnectorHandshake(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const body = yield* readBody(request, requestBodyLimitForRoute("connectorHandshake"));
      const presented = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProfileConnectorSchema),
        { onExcessProperty: "error" },
      )(body).pipe(
        Effect.matchEffect({
          onFailure: () =>
            writeJson(
              response,
              400,
              { ok: false, error: "connector metadata is malformed" },
              headers,
            ).pipe(Effect.as(undefined)),
          onSuccess: Effect.succeed,
        }),
      );
      if (!presented) return;
      const accepted = yield* this.connectors.adopt(presented).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          writeJson(response, 409, { ok: false, error: error.message }, headers).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!accepted) return;
      yield* PubSub.publish(this.readinessSignals, undefined);
      const identified = yield* this.identifyAuthorizedConnector(request, response, headers);
      if (!identified) return;
      const clientNonce = String(request.headers[CONNECTOR_CLIENT_NONCE_HEADER] ?? "");
      if (!isHex256(clientNonce)) {
        return yield* writeJson(
          response,
          400,
          { ok: false, error: "connector client nonce is missing or malformed" },
          headers,
        );
      }
      const authentication = this.serverAuthentication;
      if (!authentication) {
        return yield* writeJson(
          response,
          503,
          { ok: false, error: "bridge authentication epoch is not initialized" },
          headers,
        );
      }
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const challenge = authentication.issue("connector", now);
      const message = connectorServerProofMessage(
        "connectorServerProof",
        identified.connector,
        clientNonce,
        challenge,
        this.protocolFingerprint,
      );
      return yield* writeJson(
        response,
        200,
        {
          bridgeDisplayVersion: this.displayVersion(),
          protocolFingerprint: this.protocolFingerprint,
          ...challenge,
          proof: nodeHmacProof(identified.profile.secret, message),
        },
        headers,
      );
    });
  }

  private authorizeConnectorRequest(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
  ): Effect.Effect<AuthorizedConnectorRequest | undefined, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const identified = yield* this.identifyAuthorizedConnector(request, response, headers);
      if (!identified) return undefined;
      const proofHeaders = connectorProofHeaders(request);
      const authentication = this.serverAuthentication;
      const challenge = {
        bridgeEpoch: proofHeaders.bridgeEpoch,
        requestNonce: proofHeaders.requestNonce,
      } satisfies BridgeRequestChallenge;
      const message = connectorRequestProofMessage(
        "connectorRequestProof",
        identified.connector,
        challenge,
        request.method ?? "",
        path,
        proofHeaders.bodyHash,
      );
      if (!authentication) {
        yield* writeJson(
          response,
          503,
          { ok: false, error: "bridge authentication session is not active" },
          headers,
        );
        return undefined;
      }
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const admission = authentication.authorize("connector", proofHeaders, now);
      if (admission._tag === "Malformed") {
        yield* writeJson(
          response,
          401,
          { ok: false, error: "connector request proof is invalid" },
          headers,
        );
        return undefined;
      }
      if (admission._tag === "Unavailable") {
        yield* writeJson(
          response,
          401,
          { ok: false, error: "connector challenge is unavailable, expired, or consumed" },
          headers,
        );
        return undefined;
      }
      if (!hasValidNodeHmacProof(identified.profile.secret, message, proofHeaders.proof)) {
        yield* writeJson(
          response,
          401,
          { ok: false, error: "connector request proof is invalid" },
          headers,
        );
        return undefined;
      }
      return {
        ...identified,
        expectedBodyHash: proofHeaders.bodyHash,
      };
    });
  }

  private readConnectorBody(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    routeName: ConnectorAuthenticatedRouteName,
    expectedBodyHash: string,
  ): Effect.Effect<string | undefined, ProtocolFailure> {
    return Effect.gen(function* () {
      const body = yield* readBody(request, requestBodyLimitForRoute(routeName));
      if (hashBridgeRequestBody(body) === expectedBodyHash) return body;
      yield* writeJson(
        response,
        401,
        { ok: false, error: "connector request body hash is invalid" },
        headers,
      );
      return undefined;
    });
  }

  private bind = () =>
    Effect.callback<BridgeMode, BridgeBindFailed>((resume) => {
      const authentication = new BridgeAuthenticationSession();
      const server = createServer((request, response) => this.runRequest(request, response));
      let active = true;
      server.requestTimeout = INCOMING_REQUEST_DEADLINE_MS;
      server.headersTimeout = INCOMING_HEADERS_DEADLINE_MS;
      server.maxConnections = INCOMING_CONNECTION_LIMIT;
      const onError = (cause: NodeJS.ErrnoException) => {
        if (!active) return;
        active = false;
        server.close();
        if (cause.code === "EADDRINUSE") {
          this.runtime = { mode: "client" };
          resume(Effect.succeed("client"));
        } else {
          this.runtime = { mode: "stopped" };
          resume(
            Effect.fail(new BridgeBindFailed({ message: `Failed to bind ${this.url}`, cause })),
          );
        }
      };
      server.once("error", onError);
      server.listen(this.port, this.host, () => {
        if (!active) {
          server.close();
          return;
        }
        active = false;
        server.off("error", onError);
        this.runtime = { mode: "server", server, authentication };
        resume(Effect.succeed("server"));
      });
      return Effect.sync(() => {
        if (!active) return;
        active = false;
        server.off("error", onError);
        server.close();
      });
    });

  private runRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const cancel = effectRuntime.runCallback(
      this.handle(request, response).pipe(
        Effect.catch((error) =>
          response.headersSent
            ? Effect.logWarning(
                "pi-chrome bridge request failed after response headers were sent",
                messageOf(error),
              )
            : writeJson(response, requestFailureHttpStatus(error, 500), {
                ok: false,
                error: messageOf(error),
              }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("pi-chrome bridge could not write an error response", messageOf(error)),
        ),
      ),
      { onExit: () => undefined },
    );
    response.once("close", () => {
      if (!response.writableEnded) cancel();
    });
  };

  private handle(request: IncomingMessage, response: ServerResponse) {
    return Effect.gen({ self: this }, function* () {
      const path = yield* parseBridgeRequestPath(request, this.url);
      const headers = extensionHeaders(request);
      const resolution = resolveBridgeRoute(request.method, path);
      if (resolution._tag === "NotFound") {
        return yield* writeJson(response, 404, { ok: false, error: "not found" });
      }
      if (resolution._tag === "Ambiguous") {
        return yield* writeJson(response, 500, {
          ok: false,
          error: `ambiguous bridge route: ${resolution.names.join(", ")}`,
        });
      }
      const routeName = resolution.name;
      let ownerBody = "";
      if (isOwnerBridgeRouteName(routeName) && routeName !== "ownerHandshake") {
        const authorized = yield* this.authorizeOwnerRequest(request, response, path);
        if (!authorized) return;
        const body = yield* this.readOwnerBody(request, response, routeName, authorized);
        if (body === undefined) return;
        ownerBody = body;
      }

      const handlers: Record<BridgeRouteName, () => Effect.Effect<void, ProtocolFailure>> = {
        preflight: () =>
          readBody(request, requestBodyLimitForRoute("preflight")).pipe(
            Effect.andThen(
              hasExpectedExtensionOrigin(request)
                ? writeJson(response, 200, { ok: true }, headers)
                : writeJson(response, 403, { ok: false, error: "extension origin not allowed" }),
            ),
          ),
        ownerHandshake: () => this.handleOwnerHandshake(request, response),
        connectorHandshake: () => this.handleConnectorHandshake(request, response, headers),
        status: () =>
          this.localStatus.pipe(Effect.flatMap((status) => writeJson(response, 200, status))),
        statusWait: () =>
          this.awaitLocalReady.pipe(Effect.flatMap((status) => writeJson(response, 200, status))),
        command: () => this.handleOwnerCommand(ownerBody, response),
        poll: () => this.handleConnectorPoll(request, response, headers, path),
        result: () => this.handleConnectorResult(request, response, headers, path),
      };
      return yield* handlers[routeName]();
    });
  }

  private handleOwnerCommand(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const envelope = yield* decodeForwardRequestJson(body);
      const { session, timeoutMs, ...wireRequest } = envelope;
      const result = yield* this.sendBound(Effect.void, wireRequest, session, timeoutMs).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: (value) => ({ ok: true, value }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 504, result);
    });
  }

  private readAuthorizedConnectorBody(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
    routeName: ConnectorAuthenticatedRouteName,
  ): Effect.Effect<
    { readonly connector: PublicConnector; readonly body: string } | undefined,
    ProtocolFailure
  > {
    return Effect.gen({ self: this }, function* () {
      const authorized = yield* this.authorizeConnectorRequest(request, response, headers, path);
      if (!authorized) return undefined;
      const body = yield* this.readConnectorBody(
        request,
        response,
        headers,
        routeName,
        authorized.expectedBodyHash,
      );
      return body === undefined ? undefined : { connector: authorized.connector, body };
    });
  }

  private handleConnectorPoll(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const authorized = yield* this.readAuthorizedConnectorBody(
        request,
        response,
        headers,
        path,
        "poll",
      );
      if (!authorized) return;
      return yield* this.handlePoll(authorized.connector, response, headers);
    });
  }

  private handleConnectorResult(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const authorized = yield* this.readAuthorizedConnectorBody(
        request,
        response,
        headers,
        path,
        "result",
      );
      if (!authorized) return;
      return yield* this.handleResult(authorized.connector, authorized.body, response, headers);
    });
  }

  private handlePoll(
    connector: PublicConnector,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      if (yield* this.respondIfIncompatible(connector, response, headers)) return;
      const command = yield* this.broker.next(
        connector,
        POLL_WAIT_DEADLINE_MS,
        PubSub.publish(this.readinessSignals, undefined).pipe(Effect.asVoid),
      );
      const expectation = this.extensionExpectation;
      yield* writeJson(
        response,
        200,
        command
          ? {
              type: "command",
              command,
              expectedExtensionId: expectation.extensionId,
              expectedExtensionDisplayVersion: expectation.displayVersion,
              expectedProtocolFingerprint: expectation.protocolFingerprint,
            }
          : {
              type: "none",
              expectedExtensionId: expectation.extensionId,
              expectedExtensionDisplayVersion: expectation.displayVersion,
              expectedProtocolFingerprint: expectation.protocolFingerprint,
            },
        headers,
      );
    });
  }

  private handleResult(
    connector: PublicConnector,
    body: string,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const result = yield* decodeWireResultJson(body);
      const completed = yield* this.broker.complete(connector, result);
      yield* writeJson(
        response,
        completed
          ? RESULT_DELIVERY_POLICY.acknowledgedStatus
          : RESULT_DELIVERY_POLICY.unknownCommandStatus,
        completed ? { ok: true } : { ok: false, error: "unknown command id" },
        headers,
      );
    }).pipe(
      Effect.catch((error) =>
        writeJson(
          response,
          requestFailureHttpStatus(error, 400),
          { ok: false, error: messageOf(error) },
          headers,
        ),
      ),
    );
  }

  private respondIfIncompatible(
    connector: PublicConnector,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<boolean, ProtocolFailure> {
    const expectation = this.extensionExpectation;
    const compatibility = classifyChromeConnectorCompatibility(expectation, connector);
    if (compatibility._tag === "Verified") return Effect.succeed(false);
    return writeJson(
      response,
      200,
      {
        type: "incompatible",
        expectedExtensionId: expectation.extensionId,
        expectedExtensionDisplayVersion: expectation.displayVersion,
        actualExtensionDisplayVersion: connector.extensionDisplayVersion,
        expectedProtocolFingerprint: expectation.protocolFingerprint,
        actualProtocolFingerprint: connector.protocolFingerprint,
      },
      headers,
    ).pipe(Effect.as(true));
  }

  private sendBound<AdmissionError, AdmissionRequirements>(
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure | AdmissionError, AdmissionRequirements> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const connector = yield* this.connectors.requireConnector;
        yield* admission;
        return yield* this.broker.send(connector.connectorId, request, session, timeoutMs);
      }),
    );
  }

  private sendViaOwner<AdmissionError, AdmissionRequirements>(
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<
    unknown,
    BridgeFailure | BridgeStartFailure | AdmissionError,
    AdmissionRequirements
  > {
    const submit = Effect.gen({ self: this }, function* () {
      const identity = yield* this.ownerIdentity;
      return yield* forwardCommandToOwner(
        this.url,
        identity,
        request,
        session,
        timeoutMs,
        admission,
      );
    });
    return submit.pipe(
      Effect.catchTag("CommandOutcomeUnknown", (error) =>
        this.promote.pipe(
          Effect.catch((promotionError) =>
            Effect.logWarning(
              "pi-chrome owner promotion failed after an unknown command outcome",
              messageOf(promotionError),
            ),
          ),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
  }

  private get promote(): Effect.Effect<BridgeMode, BridgeStartFailure> {
    return this.ownership.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (this.runtime.mode === "server") return "server";
        if (this.runtime.mode === "closed")
          return yield* new BridgeUnavailable({ message: "Chrome bridge is closed" });
        this.runtime = { mode: "stopped" };
        yield* this.loadOwnerIdentity;
        const mode = yield* this.bind();
        if (mode === "client") yield* this.verifyOwner;
        return mode;
      }),
    );
  }
}
