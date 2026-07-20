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
  decodeForwardResponseJson,
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
import { ForwardRequest as ForwardRequestSchema } from "../protocol/schema.js";
import type {
  BridgeStatusResponse,
  SessionContext,
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

export const waitForStatusFromOwner = (
  url: string,
  identity: BridgeOwnerIdentity,
  timeoutMs: number,
): Effect.Effect<
  BridgeStatusResponse,
  BridgeUnavailable | BridgeOwnerUnreachable | ProtocolFailure
> =>
  authenticatedOwnerRequest(url, "statusWait", identity, {}, timeoutMs).pipe(
    Effect.flatMap(requireOwnerSuccess),
    Effect.flatMap(decodeBridgeStatusJson),
    Effect.map((status) => ({ ...status, mode: "client" as const })),
  );

export const forwardCommandToOwner = <AdmissionError, AdmissionRequirements>(
  url: string,
  identity: BridgeOwnerIdentity,
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
  const envelope = { ...request, session, timeoutMs };
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
