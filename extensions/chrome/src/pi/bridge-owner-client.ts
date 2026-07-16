import * as Effect from "effect/Effect";
import {
  BridgeUnavailable,
  BridgeOwnerUnreachable,
  CommandOutcomeUnknown,
  ProtocolFailure,
  type BridgeFailure,
} from "../core/errors.js";
import {
  decodeBridgeAuthenticationHandshakeJson,
  decodeBridgeStatusJson,
  decodeForgetResponseJson,
  decodeForwardResponseJson,
  decodePairingStateJson,
  decodeUnpairResponseJson,
  decodeWebRunLeaseMutationResponseJson,
  fromWireBridgeFailure,
} from "../protocol/codec.js";
import {
  BRIDGE_ROUTES,
  OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS,
  type OwnerBridgeRouteName,
} from "../protocol/bridge-contract.js";
import type { BridgeRequestChallenge } from "../protocol/bridge-authentication.js";
import {
  OWNER_BODY_SHA256_HEADER,
  OWNER_BRIDGE_EPOCH_HEADER,
  OWNER_CLIENT_NONCE_HEADER,
  OWNER_PROOF_HEADER,
  OWNER_PROTOCOL_FINGERPRINT_HEADER,
  OWNER_REQUEST_NONCE_HEADER,
  type BridgeOwnerIdentity,
} from "../protocol/bridge-owner.js";
import { encodeJsonTransport } from "../protocol/json-transport.js";
import {
  ForwardRequest as ForwardRequestSchema,
  SessionWebRouteDetachRequest as SessionWebRouteDetachRequestSchema,
  WebRunLeaseAcquireRequest as WebRunLeaseAcquireRequestSchema,
  WebRunLeaseReleaseRequest as WebRunLeaseReleaseRequestSchema,
} from "../protocol/schema.js";
import type {
  BridgeStatusResponse,
  ConnectorSelection,
  PairingState,
  SessionWebRouteDetachRequest,
  SessionContext,
  UnpairRequest,
  WebRunLeaseAcquireRequest,
  WebRunLeaseReleaseRequest,
  WireDomainRequest,
} from "../protocol/schema.js";
import {
  freshAuthenticationToken,
  hashBridgeRequestBody,
  hasValidOwnerServerProof,
  ownerRequestProof,
} from "./bridge-authentication-node.js";
import { ownerRequest, requireOwnerSuccess, type OwnerResponse } from "./bridge-http.js";

type OwnerRequestInit = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

type OwnerRequestAdmissionFailure<Error> = {
  readonly _tag: "OwnerRequestAdmissionFailure";
  readonly error: Error;
};

const ownerChallenge = (
  url: string,
  identity: BridgeOwnerIdentity,
): Effect.Effect<
  BridgeRequestChallenge,
  BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure
> =>
  Effect.gen(function* () {
    const clientNonce = yield* Effect.sync(freshAuthenticationToken);
    const handshake = yield* ownerRequest(url, "ownerHandshake", {
      headers: {
        [OWNER_CLIENT_NONCE_HEADER]: clientNonce,
        [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
      },
    }).pipe(
      Effect.flatMap(requireOwnerSuccess),
      Effect.flatMap(decodeBridgeAuthenticationHandshakeJson),
    );
    if (handshake.protocolFingerprint !== identity.protocolFingerprint) {
      return yield* new BridgeUnavailable({
        message: `Bridge owner protocol fingerprint ${handshake.protocolFingerprint} does not match ${identity.protocolFingerprint}`,
      });
    }
    const challenge = {
      bridgeEpoch: handshake.bridgeEpoch,
      requestNonce: handshake.requestNonce,
    } satisfies BridgeRequestChallenge;
    if (!hasValidOwnerServerProof(identity, clientNonce, challenge, handshake.proof)) {
      return yield* new BridgeUnavailable({
        message: "Shared bridge listener did not prove owner credential possession",
      });
    }
    return challenge;
  });

const authenticatedOwnerRequestAfter = <AdmissionError, AdmissionRequirements>(
  url: string,
  routeName: Exclude<OwnerBridgeRouteName, "ownerHandshake">,
  identity: BridgeOwnerIdentity,
  init: OwnerRequestInit,
  timeoutMs: number | undefined,
  admit: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
): Effect.Effect<
  OwnerResponse,
  | BridgeUnavailable
  | BridgeOwnerUnreachable
  | ProtocolFailure
  | OwnerRequestAdmissionFailure<AdmissionError>,
  AdmissionRequirements
> =>
  Effect.gen(function* () {
    const challenge = yield* ownerChallenge(url, identity);
    const route = BRIDGE_ROUTES[routeName];
    const body = init.body ?? "";
    const bodyHash = hashBridgeRequestBody(body);
    const proof = ownerRequestProof(identity, {
      ...challenge,
      method: route.method,
      path: route.path,
      bodyHash,
    });
    yield* admit.pipe(
      Effect.mapError(
        (error): OwnerRequestAdmissionFailure<AdmissionError> => ({
          _tag: "OwnerRequestAdmissionFailure",
          error,
        }),
      ),
    );
    return yield* ownerRequest(
      url,
      routeName,
      {
        ...init,
        headers: {
          ...init.headers,
          [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
          [OWNER_BRIDGE_EPOCH_HEADER]: challenge.bridgeEpoch,
          [OWNER_REQUEST_NONCE_HEADER]: challenge.requestNonce,
          [OWNER_BODY_SHA256_HEADER]: bodyHash,
          [OWNER_PROOF_HEADER]: proof,
        },
      },
      timeoutMs,
    );
  });

const authenticatedOwnerRequest = (
  url: string,
  routeName: Exclude<OwnerBridgeRouteName, "ownerHandshake">,
  identity: BridgeOwnerIdentity,
  init: OwnerRequestInit = {},
  timeoutMs?: number,
): Effect.Effect<OwnerResponse, BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure> =>
  authenticatedOwnerRequestAfter(url, routeName, identity, init, timeoutMs, Effect.void).pipe(
    Effect.catchTag("OwnerRequestAdmissionFailure", ({ error }) => Effect.fail(error)),
  );

export const handshakeWithOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
): Effect.Effect<void, BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure> =>
  ownerChallenge(url, identity).pipe(Effect.asVoid);

export const statusFromOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
): Effect.Effect<
  BridgeStatusResponse,
  BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure
> =>
  authenticatedOwnerRequest(url, "status", identity).pipe(
    Effect.flatMap(requireOwnerSuccess),
    Effect.flatMap(decodeBridgeStatusJson),
    Effect.map((status) => ({ ...status, mode: "client" as const })),
  );

export const beginPairingViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
): Effect.Effect<PairingState, BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure> =>
  authenticatedOwnerRequest(url, "pairingStart", identity).pipe(
    Effect.flatMap(requireOwnerSuccess),
    Effect.flatMap(decodePairingStateJson),
  );

export const unpairViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  request: UnpairRequest,
): Effect.Effect<void, BridgeFailure> => {
  const outcomeUnknown = (cause: unknown) =>
    new CommandOutcomeUnknown({
      message: "Bridge owner response did not establish the unpair outcome",
      cause,
    });
  const timeoutMs = request.state === "bound" ? request.timeoutMs : 0;
  return authenticatedOwnerRequest(
    url,
    "unpair",
    identity,
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    timeoutMs + OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS,
  ).pipe(
    Effect.mapError(outcomeUnknown),
    Effect.flatMap((response) =>
      decodeUnpairResponseJson(response.text).pipe(Effect.mapError(outcomeUnknown)),
    ),
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(fromWireBridgeFailure(response.error)),
    ),
  );
};

export const forgetViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  expectedConnectorId: string,
): Effect.Effect<void, BridgeFailure> => {
  const outcomeUnknown = (cause: unknown) =>
    new CommandOutcomeUnknown({
      message: "Bridge owner response did not establish the connector-forget outcome",
      cause,
    });
  return authenticatedOwnerRequest(url, "forget", identity, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedConnectorId }),
  }).pipe(
    Effect.mapError(outcomeUnknown),
    Effect.flatMap((response) =>
      decodeForgetResponseJson(response.text).pipe(Effect.mapError(outcomeUnknown)),
    ),
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(fromWireBridgeFailure(response.error)),
    ),
  );
};

const mutateWebRunLeaseViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  routeName: "webLeaseAcquire" | "webLeaseRelease" | "webLeaseAssert" | "webRouteDetach",
  label: string,
  body: string,
): Effect.Effect<void, BridgeFailure> => {
  const outcomeUnknown = (cause: unknown) =>
    new CommandOutcomeUnknown({
      message: `Bridge owner response did not establish the ${label} outcome`,
      cause,
    });
  return authenticatedOwnerRequest(url, routeName, identity, {
    headers: { "content-type": "application/json" },
    body,
  }).pipe(
    Effect.mapError(outcomeUnknown),
    Effect.flatMap((response) =>
      decodeWebRunLeaseMutationResponseJson(response.text).pipe(Effect.mapError(outcomeUnknown)),
    ),
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(fromWireBridgeFailure(response.error)),
    ),
  );
};

export const acquireWebRunLeaseViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  request: WebRunLeaseAcquireRequest,
): Effect.Effect<void, BridgeFailure> =>
  encodeJsonTransport(
    "Bridge owner web run lease acquisition request",
    WebRunLeaseAcquireRequestSchema,
    request,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolFailure({ message: "Invalid web run lease acquisition request", cause }),
    ),
    Effect.flatMap(({ json }) =>
      mutateWebRunLeaseViaOwner(
        url,
        identity,
        "webLeaseAcquire",
        "web run lease acquisition",
        json,
      ),
    ),
  );

export const releaseWebRunLeaseViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  request: WebRunLeaseReleaseRequest,
): Effect.Effect<void, BridgeFailure> =>
  encodeJsonTransport(
    "Bridge owner web run lease release request",
    WebRunLeaseReleaseRequestSchema,
    request,
  ).pipe(
    Effect.mapError(
      (cause) => new ProtocolFailure({ message: "Invalid web run lease release request", cause }),
    ),
    Effect.flatMap(({ json }) =>
      mutateWebRunLeaseViaOwner(url, identity, "webLeaseRelease", "web run lease release", json),
    ),
  );

export const assertWebRunLeaseViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  request: WebRunLeaseReleaseRequest,
): Effect.Effect<void, BridgeFailure> =>
  encodeJsonTransport(
    "Bridge owner web run lease assertion request",
    WebRunLeaseReleaseRequestSchema,
    request,
  ).pipe(
    Effect.mapError(
      (cause) => new ProtocolFailure({ message: "Invalid web run lease assertion request", cause }),
    ),
    Effect.flatMap(({ json }) =>
      mutateWebRunLeaseViaOwner(url, identity, "webLeaseAssert", "web run lease assertion", json),
    ),
  );

export const detachSessionWebRouteViaOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  request: SessionWebRouteDetachRequest,
): Effect.Effect<void, BridgeFailure> =>
  encodeJsonTransport(
    "Bridge owner session web route detach request",
    SessionWebRouteDetachRequestSchema,
    request,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolFailure({ message: "Invalid session web route detach request", cause }),
    ),
    Effect.flatMap(({ json }) =>
      mutateWebRunLeaseViaOwner(url, identity, "webRouteDetach", "session web route detach", json),
    ),
  );

export const forwardCommandToOwner = <AdmissionError, AdmissionRequirements>(
  url: string,
  identity: BridgeOwnerIdentity,
  connector: ConnectorSelection,
  request: WireDomainRequest,
  session: SessionContext,
  timeoutMs: number,
  admit: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
): Effect.Effect<unknown, BridgeFailure | AdmissionError, AdmissionRequirements> => {
  const outcomeUnknown = (cause: unknown) =>
    new CommandOutcomeUnknown({
      message: "Bridge owner response did not establish a command outcome",
      cause,
    });
  const envelope = { connector, ...request, session, timeoutMs };
  return encodeJsonTransport("Bridge owner forward request", ForwardRequestSchema, envelope).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolFailure({
          message: "Chrome command cannot cross the bridge owner JSON boundary",
          cause,
        }),
    ),
    Effect.flatMap(({ json }) =>
      authenticatedOwnerRequestAfter(
        url,
        "command",
        identity,
        {
          headers: { "content-type": "application/json" },
          body: json,
        },
        timeoutMs + OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS,
        admit,
      ).pipe(
        Effect.catchTags({
          BridgeUnavailable: (cause) => Effect.fail(outcomeUnknown(cause)),
          BridgeOwnerUnreachable: (cause) => Effect.fail(outcomeUnknown(cause)),
          ProtocolFailure: (cause) => Effect.fail(outcomeUnknown(cause)),
          OwnerRequestAdmissionFailure: ({ error }) => Effect.fail(error),
        }),
        Effect.flatMap((response) =>
          decodeForwardResponseJson(response.text).pipe(Effect.mapError(outcomeUnknown)),
        ),
        Effect.flatMap((response) =>
          response.ok
            ? Effect.succeed(response.value)
            : Effect.fail(fromWireBridgeFailure(response.error)),
        ),
      ),
    ),
  );
};
