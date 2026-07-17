import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { decodeBridgeAuthenticationHandshakeJson } from "../protocol/codec.js";
import {
  connectorRequestProofMessage,
  connectorServerProofMessage,
  type BridgeRequestChallenge,
  type ConnectorRequestProofDomain,
  type ConnectorServerProofDomain,
} from "../protocol/bridge-authentication.js";
import {
  AUTHENTICATION_HANDSHAKE_DEADLINE_MS,
  BRIDGE_ROUTES,
  CONNECTOR_REQUEST_DEADLINE_MS,
  responseBodyLimitForRoute,
  type BridgeRouteName,
  type ConnectorAuthenticatedRouteName,
} from "../protocol/bridge-contract.js";
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
  PAIRING_ID_HEADER,
} from "../protocol/connector-auth.js";
import type { ProfileConnector } from "../protocol/schema.js";
import {
  browserHmacProof,
  freshBridgeClientNonce,
  hashBrowserRequestBody,
  hasValidBrowserHmacProof,
} from "./bridge-authentication.js";

export class ConnectorHttpFailure extends Data.TaggedError("ConnectorHttpFailure")<{
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {}

export type ConnectorHttpResponse = {
  readonly status: number;
  readonly text: string;
};

const connectorHeaders = (connector: ProfileConnector): Record<string, string> => ({
  [CONNECTOR_ID_HEADER]: connector.connectorId,
  [CONNECTOR_EXTENSION_ID_HEADER]: connector.extensionId,
  [CONNECTOR_DISPLAY_VERSION_METADATA_HEADER]: connector.extensionDisplayVersion,
  [CONNECTOR_PROTOCOL_FINGERPRINT_HEADER]: connector.protocolFingerprint,
});

const requestHeaders = (
  initial: HeadersInit | undefined,
  connector: ProfileConnector,
  authentication: Readonly<Record<string, string>> = {},
): Headers => {
  const headers = new Headers(initial);
  headers.set(CONNECTOR_EXTENSION_ID_HEADER, chrome.runtime.id);
  for (const [name, value] of Object.entries({
    ...connectorHeaders(connector),
    ...authentication,
  })) {
    headers.set(name, value);
  }
  return headers;
};

type ConnectorRequestInit = Omit<RequestInit, "method" | "body"> & {
  readonly body?: string;
};

type AuthenticatedBrowserRouteName = ConnectorAuthenticatedRouteName | "pairingConfirm";

const responseTooLarge = (limitBytes: number) =>
  new ConnectorHttpFailure({
    code: "bridge-response-too-large",
    message: `Bridge response exceeds ${limitBytes} bytes`,
  });

const cancelResponseBody = (body: ReadableStream<Uint8Array>) =>
  Effect.tryPromise({
    try: () => body.cancel(),
    catch: (cause) =>
      new ConnectorHttpFailure({
        code: "bridge-response-cancel",
        message: "Could not cancel bridge response body",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("pi-chrome failed to cancel bridge response body", error.message),
    ),
  );

const readResponseText = (
  response: Response,
  limitBytes: number,
): Effect.Effect<string, ConnectorHttpFailure> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    const failure = responseTooLarge(limitBytes);
    return response.body
      ? cancelResponseBody(response.body).pipe(Effect.andThen(Effect.fail(failure)))
      : Effect.fail(failure);
  }
  if (!response.body) return Effect.succeed("");
  return Effect.callback<string, ConnectorHttpFailure>((resume) => {
    const reader = response.body!.getReader();
    const chunks: Array<Uint8Array> = [];
    let receivedBytes = 0;
    let finished = false;
    const finish = (effect: Effect.Effect<string, ConnectorHttpFailure>) => {
      if (finished) return;
      finished = true;
      resume(effect);
    };
    const read = (): void => {
      reader.read().then(
        ({ done, value }) => {
          if (finished) return;
          if (done) {
            const body = new Uint8Array(receivedBytes);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            finish(Effect.succeed(new TextDecoder().decode(body)));
            return;
          }
          receivedBytes += value.byteLength;
          if (receivedBytes > limitBytes) {
            chunks.length = 0;
            const failure = responseTooLarge(limitBytes);
            reader.cancel().then(
              () => finish(Effect.fail(failure)),
              (cause) =>
                finish(
                  Effect.logWarning(
                    "pi-chrome failed to cancel oversized bridge response",
                    String(cause),
                  ).pipe(Effect.andThen(Effect.fail(failure))),
                ),
            );
            return;
          }
          chunks.push(value);
          read();
        },
        (cause) =>
          finish(
            Effect.fail(
              new ConnectorHttpFailure({
                code: "bridge-response-read",
                message: "Could not read bridge response body",
                cause,
              }),
            ),
          ),
      );
    };
    read();
    return Effect.sync(() => {
      finished = true;
    }).pipe(
      Effect.andThen(Effect.promise(() => reader.cancel())),
      Effect.catch((cause) =>
        Effect.logWarning("pi-chrome failed to cancel bridge response reader", String(cause)),
      ),
    );
  });
};

const bridgeRequest = (
  routeName: BridgeRouteName,
  init: ConnectorRequestInit,
  connector: ProfileConnector,
  authentication: Readonly<Record<string, string>>,
  timeoutMs: number,
): Effect.Effect<ConnectorHttpResponse, ConnectorHttpFailure> => {
  const route = BRIDGE_ROUTES[routeName];
  return Effect.tryPromise({
    try: (signal) =>
      fetch(`${__PI_CHROME_BRIDGE_URL__}${route.path}`, {
        ...init,
        method: route.method,
        cache: "no-store",
        headers: requestHeaders(init.headers, connector, authentication),
        signal,
      }),
    catch: (cause) =>
      new ConnectorHttpFailure({
        code: "bridge-unavailable",
        message: `Could not reach ${__PI_CHROME_BRIDGE_URL__}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      readResponseText(response, responseBodyLimitForRoute(routeName)).pipe(
        Effect.map((text) => ({ status: response.status, text })),
      ),
    ),
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new ConnectorHttpFailure({
            code: "bridge-timeout",
            message: `Timed out after ${timeoutMs}ms waiting for ${__PI_CHROME_BRIDGE_URL__}${route.path}`,
          }),
        ),
    }),
  );
};

const authenticationFailure = (cause: unknown) =>
  cause instanceof ConnectorHttpFailure
    ? cause
    : new ConnectorHttpFailure({
        code: "bridge-authentication",
        message: "Could not authenticate the local Chrome bridge",
        cause,
      });

const authenticatedRequest = (
  handshakeRoute: "connectorHandshake" | "pairingHandshake",
  routeName: AuthenticatedBrowserRouteName,
  serverDomain: ConnectorServerProofDomain,
  requestDomain: ConnectorRequestProofDomain,
  secret: string,
  connector: ProfileConnector,
  init: ConnectorRequestInit,
  timeoutMs: number,
  requireProtocolMatch: boolean,
  pairingId?: string,
): Effect.Effect<ConnectorHttpResponse, ConnectorHttpFailure> =>
  Effect.gen(function* () {
    const clientNonce = freshBridgeClientNonce();
    const handshakeResponse = yield* bridgeRequest(
      handshakeRoute,
      handshakeRoute === "connectorHandshake"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(connector),
          }
        : {},
      connector,
      {
        [CONNECTOR_CLIENT_NONCE_HEADER]: clientNonce,
        ...(pairingId ? { [PAIRING_ID_HEADER]: pairingId } : {}),
      },
      AUTHENTICATION_HANDSHAKE_DEADLINE_MS,
    );
    const handshakeText = yield* requireConnectorSuccess(handshakeResponse);
    const handshake = yield* decodeBridgeAuthenticationHandshakeJson(handshakeText);
    const challenge = {
      bridgeEpoch: handshake.bridgeEpoch,
      requestNonce: handshake.requestNonce,
    } satisfies BridgeRequestChallenge;
    const serverMessage = connectorServerProofMessage(
      serverDomain,
      connector,
      clientNonce,
      challenge,
      handshake.protocolFingerprint,
      pairingId,
    );
    if (!(yield* hasValidBrowserHmacProof(secret, serverMessage, handshake.proof))) {
      return yield* new ConnectorHttpFailure({
        code: "bridge-listener-authentication",
        message: "Local bridge listener did not prove connector credential possession",
      });
    }
    if (requireProtocolMatch && handshake.protocolFingerprint !== connector.protocolFingerprint) {
      return yield* new ConnectorHttpFailure({
        code: "bridge-protocol-mismatch",
        message: `Bridge protocol ${handshake.protocolFingerprint} does not match ${connector.protocolFingerprint}`,
      });
    }
    const body = init.body ?? "";
    const bodyHash = yield* hashBrowserRequestBody(body);
    const route = BRIDGE_ROUTES[routeName];
    const proof = yield* browserHmacProof(
      secret,
      connectorRequestProofMessage(
        requestDomain,
        connector,
        challenge,
        route.method,
        route.path,
        bodyHash,
        pairingId,
      ),
    );
    return yield* bridgeRequest(
      routeName,
      init,
      connector,
      {
        [CONNECTOR_BRIDGE_EPOCH_HEADER]: challenge.bridgeEpoch,
        [CONNECTOR_REQUEST_NONCE_HEADER]: challenge.requestNonce,
        [CONNECTOR_BODY_SHA256_HEADER]: bodyHash,
        [CONNECTOR_PROOF_HEADER]: proof,
        ...(pairingId ? { [PAIRING_ID_HEADER]: pairingId } : {}),
      },
      timeoutMs,
    );
  }).pipe(
    Effect.mapError(authenticationFailure),
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new ConnectorHttpFailure({
            code: "bridge-timeout",
            message: `Timed out after ${timeoutMs}ms authenticating ${__PI_CHROME_BRIDGE_URL__}${BRIDGE_ROUTES[routeName].path}`,
          }),
        ),
    }),
  );

export const connectorRequest = (
  routeName: ConnectorAuthenticatedRouteName,
  init: ConnectorRequestInit,
  connector: ProfileConnector,
  timeoutMs: number = CONNECTOR_REQUEST_DEADLINE_MS,
): Effect.Effect<ConnectorHttpResponse, ConnectorHttpFailure> =>
  authenticatedRequest(
    "connectorHandshake",
    routeName,
    "connectorServerProof",
    "connectorRequestProof",
    connector.secret,
    connector,
    init,
    timeoutMs,
    false,
    undefined,
  );

export const requireConnectorSuccess = (
  response: ConnectorHttpResponse,
): Effect.Effect<string, ConnectorHttpFailure> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response.text)
    : Effect.fail(
        new ConnectorHttpFailure({
          code: "bridge-http",
          message: `Bridge returned HTTP ${response.status}: ${response.text}`,
          status: response.status,
        }),
      );
