import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import {
  classifyChromeConnectorCompatibility,
  type ChromeExtensionExpectation,
} from "@pi-suite/companion-contracts/chrome";
import { CommandBroker } from "../core/broker.js";
import {
  BridgeBindFailed,
  BridgeOwnerUnreachable,
  BridgeUnavailable,
  PairingUnavailable,
  ProtocolFailure,
  WebConnectorLeaseUnavailable,
  messageOf,
  type BridgeFailure,
} from "../core/errors.js";
import { PairingCoordinator } from "../core/pairing.js";
import {
  decodeForgetRequestJson,
  decodeForwardRequestJson,
  decodePairingConfirmRequestJson,
  decodeSessionWebRouteDetachRequestJson,
  decodeUnpairRequestJson,
  decodeWebRunLeaseAcquireRequestJson,
  decodeWebRunLeaseReleaseRequestJson,
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
  hasSameConnectorProofIdentity,
  type BridgeRequestChallenge,
} from "../protocol/bridge-authentication.js";
import {
  CONNECTOR_BODY_SHA256_HEADER,
  CONNECTOR_BRIDGE_EPOCH_HEADER,
  CONNECTOR_CLIENT_NONCE_HEADER,
  CONNECTOR_PROOF_HEADER,
  CONNECTOR_REQUEST_NONCE_HEADER,
  PAIRING_ID_HEADER,
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
  PairingId as PairingIdSchema,
  type ConnectorSelection,
  type BoundConnector,
  type BridgeStatusResponse,
  type ConnectorRouteIdentity,
  type PairingExpectation,
  type PairingState,
  type ProfileConnector,
  type PublicBoundConnector,
  type PublicConnector,
  type SessionContext,
  type WebRunLeaseClaim,
  type WebRunOffer,
  type WireDomainRequest,
} from "../protocol/schema.js";
import { ProfileConnector as ProfileConnectorSchema } from "../protocol/schema.js";
import type { ConnectorBindingStore, ConnectorBindingStoreFailure } from "./connector-binding.js";
import { ConnectorOwner } from "./connector-owner.js";
import { makeSessionConnectorBindingStore } from "./session-connector-binding.js";
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
  freshAuthenticationToken,
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
  beginPairingViaOwner,
  acquireWebRunLeaseViaOwner,
  assertWebRunLeaseViaOwner,
  detachSessionWebRouteViaOwner,
  forgetViaOwner,
  forwardCommandToOwner,
  handshakeWithOwner,
  releaseWebRunLeaseViaOwner,
  statusFromOwner,
  unpairViaOwner,
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

type AuthorizedPairingRequest = {
  readonly pairingId: string | undefined;
  readonly identity: ConnectorRouteIdentity;
  readonly expectedBodyHash: string;
  readonly authenticateCapability: (capability: string) => boolean;
};

export type BridgeStatus = BridgeStatusResponse;

type BridgeStartFailure =
  | BridgeBindFailed
  | BridgeOwnerUnreachable
  | BridgeUnavailable
  | BridgeOwnerCredentialFailure
  | ConnectorBindingStoreFailure
  | ProtocolFingerprintFailure
  | ProtocolFailure;

const publicConnector = (binding: ProfileConnector): PublicConnector => ({
  connectorId: binding.connectorId,
  label: binding.label,
  extensionId: binding.extensionId,
  extensionDisplayVersion: binding.extensionDisplayVersion,
  protocolFingerprint: binding.protocolFingerprint,
});

const publicBinding = (binding: BoundConnector): PublicBoundConnector => ({
  ...publicConnector(binding),
  pairedAt: binding.pairedAt,
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

type PairingRouteScope =
  | { readonly _tag: "Valid"; readonly pairingId: string | undefined }
  | { readonly _tag: "Invalid" };

const pairingRouteScope = (request: IncomingMessage): PairingRouteScope => {
  const value = request.headers[PAIRING_ID_HEADER];
  if (value === undefined) return { _tag: "Valid", pairingId: undefined };
  return typeof value === "string" && Schema.is(PairingIdSchema)(value)
    ? { _tag: "Valid", pairingId: value }
    : { _tag: "Invalid" };
};

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
    private readonly pairing: PairingCoordinator,
    private readonly lifecycleGate: Semaphore.Semaphore,
    private readonly ownership: Semaphore.Semaphore,
  ) {}

  static make = (
    host: string,
    port: number,
    displayVersion: () => string,
    persistence: ConnectorBindingStore,
  ) =>
    Effect.gen(function* () {
      const protocolFingerprint = yield* nodeProtocolFingerprint;
      const broker = yield* CommandBroker.make;
      const sessionBindings = yield* makeSessionConnectorBindingStore(persistence.agentDir);
      const connectors = yield* ConnectorOwner.make(persistence, broker, sessionBindings);
      const credentialStore = yield* makeBridgeOwnerCredentialStore(persistence.agentDir);
      const { ownerIdentityRef, pairing, lifecycleGate, ownership } = yield* Effect.all({
        ownerIdentityRef: Ref.make<BridgeOwnerIdentity | undefined>(undefined),
        pairing: PairingCoordinator.make,
        lifecycleGate: Semaphore.make(1),
        ownership: Semaphore.make(1),
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
        pairing,
        lifecycleGate,
        ownership,
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
        yield* provideNode(this.connectors.reload);
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

  sendTerminalGuarded<AdmissionError, AdmissionRequirements>(
    expectedConnectorId: string,
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
      if (this.runtime.mode === "server") {
        return this.sendExpectedGuarded(
          expectedConnectorId,
          admission,
          wireRequest,
          session,
          timeoutMs,
        );
      }
      if (this.runtime.mode === "client") {
        return this.sendTerminalViaOwner(
          expectedConnectorId,
          admission,
          wireRequest,
          session,
          timeoutMs,
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  beginPairing(): Effect.Effect<
    PairingState,
    BridgeStartFailure | PairingUnavailable | ProtocolFailure
  > {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") return this.beginLocalPairing;
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) => beginPairingViaOwner(this.url, identity)),
          Effect.catchTag(
            "BridgeOwnerUnreachable",
            (): Effect.Effect<
              PairingState,
              BridgeStartFailure | PairingUnavailable | ProtocolFailure
            > =>
              this.promote.pipe(
                Effect.flatMap(
                  (
                    mode,
                  ): Effect.Effect<
                    PairingState,
                    BridgeStartFailure | PairingUnavailable | ProtocolFailure
                  > =>
                    mode === "server"
                      ? this.beginLocalPairing
                      : this.ownerIdentity.pipe(
                          Effect.flatMap((identity) => beginPairingViaOwner(this.url, identity)),
                        ),
                ),
              ),
          ),
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  stageWebRunLease(
    offer: WebRunOffer,
    sessionKey: string,
  ): Effect.Effect<WebRunLeaseClaim, BridgeFailure | BridgeStartFailure> {
    const claim = {
      pairingId: offer.pairingId,
      leaseToken: freshAuthenticationToken(),
      connectorId: offer.connector.connectorId,
      sessionKey,
    } satisfies WebRunLeaseClaim;
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") {
        return this.stageLocalWebRunLease(offer, claim).pipe(Effect.as(claim));
      }
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) =>
            acquireWebRunLeaseViaOwner(this.url, identity, { offer, claim }),
          ),
          Effect.as(claim),
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  assertWebRunLease(
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, BridgeFailure | BridgeStartFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") return this.requireLocalWebRunLease(claim);
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) => assertWebRunLeaseViaOwner(this.url, identity, { claim })),
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  releaseWebRunLease(
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, BridgeFailure | BridgeStartFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") return this.releaseLocalWebRunLease(claim);
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) => releaseWebRunLeaseViaOwner(this.url, identity, { claim })),
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  detachSessionWebRoute(
    sessionKey: string,
    generation: string,
  ): Effect.Effect<void, BridgeFailure | BridgeStartFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") {
        return this.detachLocalSessionWebRoute(sessionKey, generation);
      }
      if (this.runtime.mode === "client") {
        return this.ownerIdentity.pipe(
          Effect.flatMap((identity) =>
            detachSessionWebRouteViaOwner(this.url, identity, { sessionKey, generation }),
          ),
        );
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  sendWebGuarded<AdmissionError, AdmissionRequirements>(
    claim: WebRunLeaseClaim,
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
      if (this.runtime.mode === "server") {
        return this.sendWebBound(claim, admission, wireRequest, session, timeoutMs);
      }
      if (this.runtime.mode === "client") {
        return this.sendWebViaOwner(claim, admission, wireRequest, session, timeoutMs);
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  unpair(
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<void, BridgeFailure | BridgeStartFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") return this.unpairBound(session, timeoutMs);
      if (this.runtime.mode === "client") {
        return Effect.gen({ self: this }, function* () {
          yield* provideNode(this.connectors.reload);
          const binding = yield* this.connectors.current;
          const identity = yield* this.ownerIdentity;
          yield* unpairViaOwner(
            this.url,
            identity,
            binding
              ? {
                  state: "bound",
                  expectedConnectorId: binding.connectorId,
                  session,
                  timeoutMs,
                }
              : { state: "unbound" },
          );
          yield* provideNode(this.connectors.reload);
        });
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  forget(expectedConnectorId: string): Effect.Effect<void, BridgeFailure | BridgeStartFailure> {
    return Effect.suspend(() => {
      if (this.runtime.mode === "server") return this.forgetExpected(expectedConnectorId);
      if (this.runtime.mode === "client") {
        return Effect.gen({ self: this }, function* () {
          const identity = yield* this.ownerIdentity;
          yield* forgetViaOwner(this.url, identity, expectedConnectorId);
          yield* provideNode(this.connectors.reload);
        });
      }
      return Effect.fail(new BridgeUnavailable({ message: "Chrome bridge is not started" }));
    });
  }

  private get localStatus(): Effect.Effect<BridgeStatus> {
    return Effect.gen({ self: this }, function* () {
      const binding = yield* this.connectors.current;
      const sessionRoutes = yield* this.connectors.sessionRouteStatuses;
      const extensionExpectation = this.extensionExpectation;
      if (!binding) {
        return { url: this.url, mode: this.runtime.mode, sessionRoutes, extensionExpectation };
      }
      return {
        url: this.url,
        mode: this.runtime.mode,
        sessionRoutes,
        extensionExpectation,
        binding: publicBinding(binding),
        connector: yield* this.broker.status(binding.connectorId),
      };
    });
  }

  private get pairingExpectation(): PairingExpectation {
    const expectation = this.extensionExpectation;
    return {
      expectedExtensionId: expectation.extensionId,
      expectedExtensionDisplayVersion: expectation.displayVersion,
      expectedProtocolFingerprint: expectation.protocolFingerprint,
    };
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

  private identifyPairingConnector(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<ConnectorRouteIdentity | undefined, ProtocolFailure> {
    return identifyExtensionConnectorRequest(request).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          writeJson(response, 403, { ok: false, error: error.message }, headers).pipe(
            Effect.as(undefined),
          ),
        onSuccess: Effect.succeed,
      }),
    );
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
      const current = yield* this.connectors.current;
      if (!current || current.connectorId === presented.connectorId) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const accepted = yield* provideNode(
          this.connectors.replace({
            ...presented,
            pairedAt: current?.pairedAt ?? now,
          }),
        ).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            writeJson(response, 409, { ok: false, error: error.message }, headers).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (!accepted) return;
      }
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

  private handlePairingHandshake(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* readBody(request, requestBodyLimitForRoute("pairingHandshake"));
      const scope = pairingRouteScope(request);
      if (scope._tag === "Invalid") {
        return yield* writeJson(
          response,
          400,
          { ok: false, error: "pairing id is malformed" },
          headers,
        );
      }
      const identity = yield* this.identifyPairingConnector(request, response, headers);
      if (!identity) return;
      const clientNonce = String(request.headers[CONNECTOR_CLIENT_NONCE_HEADER] ?? "");
      if (!isHex256(clientNonce)) {
        return yield* writeJson(
          response,
          400,
          { ok: false, error: "pairing client nonce is missing or malformed" },
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
      const challenge = authentication.issue("pairing", now);
      const message = connectorServerProofMessage(
        "pairingServerProof",
        identity,
        clientNonce,
        challenge,
        this.protocolFingerprint,
        scope.pairingId,
      );
      const proof = yield* this.pairing
        .prove(scope.pairingId, (capability) => nodeHmacProof(capability, message))
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              authentication.revoke("pairing", challenge.requestNonce, now);
            }).pipe(
              Effect.andThen(
                writeJson(response, 409, { ok: false, error: error.message }, headers),
              ),
              Effect.as(undefined),
            ),
          ),
        );
      if (!proof) return;
      return yield* writeJson(
        response,
        200,
        {
          bridgeDisplayVersion: this.displayVersion(),
          protocolFingerprint: this.protocolFingerprint,
          ...challenge,
          proof,
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

  private authorizePairingRequest(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
  ): Effect.Effect<AuthorizedPairingRequest | undefined, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const scope = pairingRouteScope(request);
      if (scope._tag === "Invalid") {
        yield* writeJson(response, 400, { ok: false, error: "pairing id is malformed" }, headers);
        return undefined;
      }
      const identity = yield* this.identifyPairingConnector(request, response, headers);
      if (!identity) return undefined;
      const proofHeaders = connectorProofHeaders(request);
      const authentication = this.serverAuthentication;
      const challenge = {
        bridgeEpoch: proofHeaders.bridgeEpoch,
        requestNonce: proofHeaders.requestNonce,
      } satisfies BridgeRequestChallenge;
      const message = connectorRequestProofMessage(
        "pairingRequestProof",
        identity,
        challenge,
        request.method ?? "",
        path,
        proofHeaders.bodyHash,
        scope.pairingId,
      );
      const authenticateCapability = (capability: string) =>
        hasValidNodeHmacProof(capability, message, proofHeaders.proof);
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
      const admission = authentication.authorize("pairing", proofHeaders, now);
      if (admission._tag === "Malformed") {
        yield* writeJson(
          response,
          401,
          { ok: false, error: "pairing request proof is invalid" },
          headers,
        );
        return undefined;
      }
      if (admission._tag === "Unavailable") {
        yield* writeJson(
          response,
          401,
          { ok: false, error: "pairing challenge is unavailable, expired, or consumed" },
          headers,
        );
        return undefined;
      }
      const authenticated = yield* this.pairing
        .prove(scope.pairingId, authenticateCapability)
        .pipe(
          Effect.catch((error) =>
            writeJson(response, 409, { ok: false, error: error.message }, headers).pipe(
              Effect.as(undefined),
            ),
          ),
        );
      if (authenticated !== true) {
        if (authenticated === false) {
          yield* writeJson(
            response,
            401,
            { ok: false, error: "pairing request proof is invalid" },
            headers,
          );
        }
        return undefined;
      }
      return {
        pairingId: scope.pairingId,
        identity,
        expectedBodyHash: proofHeaders.bodyHash,
        authenticateCapability,
      };
    });
  }

  private readConnectorBody(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    routeName: ConnectorAuthenticatedRouteName | "pairingConfirm",
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
        pairingHandshake: () => this.handlePairingHandshake(request, response, headers),
        status: () =>
          this.localStatus.pipe(Effect.flatMap((status) => writeJson(response, 200, status))),
        pairingStart: () =>
          this.beginLocalPairing.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                writeJson(response, 409, { ok: false, error: messageOf(error) }),
              onSuccess: (state) => writeJson(response, 200, state),
            }),
          ),
        webLeaseAcquire: () => this.handleOwnerWebLeaseAcquire(ownerBody, response),
        webLeaseRelease: () => this.handleOwnerWebLeaseRelease(ownerBody, response),
        webLeaseAssert: () => this.handleOwnerWebLeaseAssert(ownerBody, response),
        webRouteDetach: () => this.handleOwnerWebRouteDetach(ownerBody, response),
        unpair: () => this.handleOwnerUnpair(ownerBody, response),
        forget: () => this.handleOwnerForget(ownerBody, response),
        command: () => this.handleOwnerCommand(ownerBody, response),
        pairingConfirm: () => this.handlePairingConfirm(request, response, headers, path),
        poll: () => this.handleConnectorPoll(request, response, headers, path),
        result: () => this.handleConnectorResult(request, response, headers, path),
      };
      return yield* handlers[routeName]();
    });
  }

  private handleOwnerUnpair(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const unpair = yield* decodeUnpairRequestJson(body);
      const result = yield* (
        unpair.state === "bound"
          ? this.unpairExpected(unpair.expectedConnectorId, unpair.session, unpair.timeoutMs)
          : this.unpairExpectedUnbound
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerWebLeaseAcquire(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const request = yield* decodeWebRunLeaseAcquireRequestJson(body);
      const result = yield* this.stageLocalWebRunLease(request.offer, request.claim).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerWebLeaseRelease(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const request = yield* decodeWebRunLeaseReleaseRequestJson(body);
      const result = yield* this.releaseLocalWebRunLease(request.claim).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerWebLeaseAssert(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const request = yield* decodeWebRunLeaseReleaseRequestJson(body);
      const result = yield* this.requireLocalWebRunLease(request.claim).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerWebRouteDetach(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const request = yield* decodeSessionWebRouteDetachRequestJson(body);
      const result = yield* this.detachLocalSessionWebRoute(
        request.sessionKey,
        request.generation,
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerForget(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const forget = yield* decodeForgetRequestJson(body);
      const result = yield* this.forgetExpected(forget.expectedConnectorId).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: () => ({ ok: true }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 409, result);
    });
  }

  private handleOwnerCommand(
    body: string,
    response: ServerResponse,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const envelope = yield* decodeForwardRequestJson(body);
      const { connector, session, timeoutMs, ...wireRequest } = envelope;
      const result = yield* this.sendSelected(connector, wireRequest, session, timeoutMs).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false, error: toWireBridgeFailure(error) }) as const,
          onSuccess: (value) => ({ ok: true, value }) as const,
        }),
      );
      return yield* writeJson(response, result.ok ? 200 : 504, result);
    });
  }

  private handlePairingConfirm(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
    path: string,
  ): Effect.Effect<void, ProtocolFailure> {
    return Effect.gen({ self: this }, function* () {
      const authorized = yield* this.authorizePairingRequest(request, response, headers, path);
      if (!authorized) return;
      const body = yield* this.readConnectorBody(
        request,
        response,
        headers,
        "pairingConfirm",
        authorized.expectedBodyHash,
      );
      if (body === undefined) return;
      const confirmation = yield* decodePairingConfirmRequestJson(body);
      if (!hasSameConnectorProofIdentity(confirmation.connector, authorized.identity)) {
        return yield* writeJson(
          response,
          401,
          { ok: false, error: "pairing connector body does not match signed identity" },
          headers,
        );
      }
      return yield* this.confirmPairing(
        authorized.pairingId,
        confirmation.connector,
        authorized.authenticateCapability,
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            writeJson(response, 409, { ok: false, error: messageOf(error) }, headers),
          onSuccess: (connector) => writeJson(response, 200, { ok: true, connector }, headers),
        }),
      );
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
      const command = yield* this.broker.next(connector, POLL_WAIT_DEADLINE_MS);
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

  private get beginLocalPairing(): Effect.Effect<PairingState, PairingUnavailable> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.current;
        if (binding) {
          return yield* new PairingUnavailable({
            message: `Chrome profile ${binding.label} is already paired; run /chrome unpair before onboarding another profile`,
          });
        }
        return yield* this.pairing.begin(this.pairingExpectation);
      }),
    );
  }

  private stageLocalWebRunLease(
    offer: WebRunOffer,
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const compatibility = classifyChromeConnectorCompatibility(
          this.extensionExpectation,
          offer.connector,
        );
        if (compatibility._tag === "Incompatible") {
          return yield* new WebConnectorLeaseUnavailable({
            pairingId: claim.pairingId,
            message: `Web run offer does not match this pi-chrome package: ${compatibility.mismatches.join(", ")}`,
          });
        }
        if (yield* this.connectors.hasWebLease(claim)) return;
        yield* this.pairing.stageWeb(offer, claim).pipe(
          Effect.mapError(
            (error) =>
              new WebConnectorLeaseUnavailable({
                pairingId: claim.pairingId,
                message: error.message,
              }),
          ),
        );
      }),
    );
  }

  private requireLocalWebRunLease(
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, WebConnectorLeaseUnavailable> {
    return this.lifecycleGate.withPermits(1)(
      this.connectors.hasWebLease(claim).pipe(
        Effect.flatMap((available) =>
          available
            ? Effect.void
            : Effect.fail(
                new WebConnectorLeaseUnavailable({
                  pairingId: claim.pairingId,
                  message: `Web connector lease ${claim.pairingId} is unavailable or expired`,
                }),
              ),
        ),
      ),
    );
  }

  private releaseLocalWebRunLease(
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, WebConnectorLeaseUnavailable | BridgeUnavailable> {
    return this.lifecycleGate.withPermits(1)(
      this.pairing.cancelWeb(claim).pipe(
        Effect.mapError(
          (error) =>
            new WebConnectorLeaseUnavailable({
              pairingId: claim.pairingId,
              message: error.message,
            }),
        ),
        Effect.andThen(
          provideNode(this.connectors.releaseWebLease(claim)).pipe(
            Effect.catchTag("ConnectorBindingStoreFailure", (cause) =>
              Effect.fail(
                new BridgeUnavailable({
                  message: "Failed to persist the detached Chrome session connector binding",
                  cause,
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  private detachLocalSessionWebRoute(
    sessionKey: string,
    generation: string,
  ): Effect.Effect<void, BridgeUnavailable> {
    return this.lifecycleGate.withPermits(1)(
      provideNode(this.connectors.detachWebRoute(sessionKey, generation)).pipe(
        Effect.mapError(
          (cause) =>
            new BridgeUnavailable({
              message: "Failed to persist the detached Chrome session connector route",
              cause,
            }),
        ),
      ),
    );
  }

  private confirmPairing(
    pairingId: string | undefined,
    connector: ProfileConnector,
    authenticateCapability: (capability: string) => boolean,
  ) {
    const compatibility = classifyChromeConnectorCompatibility(
      this.extensionExpectation,
      connector,
    );
    if (compatibility._tag === "Incompatible")
      return Effect.fail(
        new PairingUnavailable({
          message: `connector does not match this pi-chrome package: ${compatibility.mismatches.join(", ")}`,
        }),
      );
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        return yield* this.pairing.confirmAuthenticated(pairingId, authenticateCapability, (web) =>
          Effect.gen({ self: this }, function* () {
            if (web) {
              if (
                !hasSameConnectorProofIdentity(web.offer.connector, connector) ||
                web.offer.connector.label !== connector.label
              ) {
                return yield* new PairingUnavailable({
                  message: "Confirmed connector does not match the web run offer",
                });
              }
              yield* provideNode(this.connectors.registerWebLease(web.claim, connector));
              return publicConnector(connector);
            }
            const current = yield* this.connectors.current;
            if (current) {
              return yield* new PairingUnavailable({
                message: `Chrome profile ${current.label} is already paired; run /chrome unpair before onboarding another profile`,
              });
            }
            const pairedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            const binding = { ...connector, pairedAt } satisfies BoundConnector;
            yield* provideNode(this.connectors.replace(binding));
            return publicConnector(binding);
          }),
        );
      }),
    );
  }

  private get clearLocalBinding(): Effect.Effect<void, BridgeUnavailable> {
    return Effect.gen({ self: this }, function* () {
      yield* this.pairing.cancel;
      yield* provideNode(this.connectors.clear).pipe(
        Effect.mapError(
          (cause) =>
            new BridgeUnavailable({
              message: "Failed to clear the Chrome profile connector binding",
              cause,
            }),
        ),
      );
    });
  }

  private cleanupAndClear(
    binding: BoundConnector,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<void, BridgeFailure> {
    return this.broker
      .send(
        binding.connectorId,
        { domain: "system", call: { op: "cleanup-all" } },
        session,
        timeoutMs,
      )
      .pipe(Effect.andThen(this.clearLocalBinding));
  }

  private unpairBound(
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<void, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.current;
        if (!binding) return yield* this.clearLocalBinding;
        return yield* this.cleanupAndClear(binding, session, timeoutMs);
      }),
    );
  }

  private unpairExpected(
    expectedConnectorId: string,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<void, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.expectBoundConnector(expectedConnectorId);
        return yield* this.cleanupAndClear(binding, session, timeoutMs);
      }),
    );
  }

  private get unpairExpectedUnbound(): Effect.Effect<void, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        yield* this.connectors.expectNoConnector;
        return yield* this.clearLocalBinding;
      }),
    );
  }

  private forgetExpected(expectedConnectorId: string): Effect.Effect<void, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        yield* this.connectors.expectBoundConnector(expectedConnectorId);
        return yield* this.clearLocalBinding;
      }),
    );
  }

  private sendBound<AdmissionError, AdmissionRequirements>(
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure | AdmissionError, AdmissionRequirements> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.requireBoundConnector;
        yield* admission;
        return yield* this.broker.send(binding.connectorId, request, session, timeoutMs);
      }),
    );
  }

  private sendExpected(
    expectedConnectorId: string,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.expectBoundConnector(expectedConnectorId);
        return yield* this.broker.send(binding.connectorId, request, session, timeoutMs);
      }),
    );
  }

  private sendExpectedGuarded<AdmissionError, AdmissionRequirements>(
    expectedConnectorId: string,
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure | AdmissionError, AdmissionRequirements> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const binding = yield* this.connectors.expectBoundConnector(expectedConnectorId);
        yield* admission;
        return yield* this.broker.send(binding.connectorId, request, session, timeoutMs);
      }),
    );
  }

  private sendSelected(
    selection: ConnectorSelection,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure> {
    if (selection.source === "terminal") {
      return this.sendExpected(selection.expectedConnectorId, request, session, timeoutMs);
    }
    return this.lifecycleGate.withPermits(1)(
      this.connectors.useWebLease(selection.claim, (connector) =>
        selection.claim.sessionKey === session.key
          ? this.broker.send(connector.connectorId, request, session, timeoutMs)
          : Effect.fail(
              new WebConnectorLeaseUnavailable({
                pairingId: selection.claim.pairingId,
                message: "Web connector lease belongs to another Pi session",
              }),
            ),
      ),
    );
  }

  private sendWebBound<AdmissionError, AdmissionRequirements>(
    claim: WebRunLeaseClaim,
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure | AdmissionError, AdmissionRequirements> {
    return this.lifecycleGate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (claim.sessionKey !== session.key) {
          return yield* new WebConnectorLeaseUnavailable({
            pairingId: claim.pairingId,
            message: "Web connector lease belongs to another Pi session",
          });
        }
        yield* admission;
        return yield* this.connectors.useWebLease(claim, (connector) =>
          this.broker.send(connector.connectorId, request, session, timeoutMs),
        );
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
      yield* provideNode(this.connectors.reload);
      const binding = yield* this.connectors.requireBoundConnector;
      const identity = yield* this.ownerIdentity;
      return yield* forwardCommandToOwner(
        this.url,
        identity,
        { source: "terminal", expectedConnectorId: binding.connectorId },
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

  private sendWebViaOwner<AdmissionError, AdmissionRequirements>(
    claim: WebRunLeaseClaim,
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
      if (claim.sessionKey !== session.key) {
        return yield* new WebConnectorLeaseUnavailable({
          pairingId: claim.pairingId,
          message: "Web connector lease belongs to another Pi session",
        });
      }
      const identity = yield* this.ownerIdentity;
      return yield* forwardCommandToOwner(
        this.url,
        identity,
        { source: "web", claim },
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
              "pi-chrome owner promotion failed after an unknown web command outcome",
              messageOf(promotionError),
            ),
          ),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
  }

  private sendTerminalViaOwner<AdmissionError, AdmissionRequirements>(
    expectedConnectorId: string,
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
        { source: "terminal", expectedConnectorId },
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
        yield* provideNode(this.connectors.reload);
        const mode = yield* this.bind();
        if (mode === "client") yield* this.verifyOwner;
        return mode;
      }),
    );
  }
}
