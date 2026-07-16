import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IncomingMessage } from "node:http";
import { ConnectorAuthenticationFailed } from "../core/errors.js";
import {
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_ID_HEADER,
  CONNECTOR_DISPLAY_VERSION_METADATA_HEADER,
  CONNECTOR_PROTOCOL_FINGERPRINT_HEADER,
} from "../protocol/connector-auth.js";
import {
  ConnectorRouteIdentity as ConnectorRouteIdentitySchema,
  type ConnectorRouteIdentity,
  type ProfileConnector,
  type PublicConnector,
} from "../protocol/schema.js";
import { isExpectedExtensionRequest } from "./bridge-http.js";
import { EXTENSION_PACKAGE_ID } from "./extension-package.js";

export const identifyExtensionConnectorRequest = (
  request: IncomingMessage,
): Effect.Effect<ConnectorRouteIdentity, ConnectorAuthenticationFailed> =>
  Effect.gen(function* () {
    if (!isExpectedExtensionRequest(request)) {
      return yield* new ConnectorAuthenticationFailed({
        message: "extension package identity does not match",
      });
    }
    return yield* Schema.decodeUnknownEffect(ConnectorRouteIdentitySchema, {
      onExcessProperty: "error",
    })({
      connectorId: request.headers[CONNECTOR_ID_HEADER],
      extensionId: request.headers[CONNECTOR_EXTENSION_ID_HEADER],
      extensionDisplayVersion: request.headers[CONNECTOR_DISPLAY_VERSION_METADATA_HEADER],
      protocolFingerprint: request.headers[CONNECTOR_PROTOCOL_FINGERPRINT_HEADER],
    }).pipe(
      Effect.mapError(
        () =>
          new ConnectorAuthenticationFailed({
            message: "connector route identity headers are missing or malformed",
          }),
      ),
    );
  });

export const identifyConnectorRequest = (
  request: IncomingMessage,
  connector: ProfileConnector | undefined,
): Effect.Effect<PublicConnector, ConnectorAuthenticationFailed> =>
  Effect.gen(function* () {
    if (!connector) {
      return yield* new ConnectorAuthenticationFailed({
        message: "Chrome connector is not authorized",
      });
    }
    const identity = yield* identifyExtensionConnectorRequest(request);
    if (
      identity.connectorId !== connector.connectorId ||
      identity.extensionId !== EXTENSION_PACKAGE_ID ||
      identity.extensionId !== connector.extensionId
    ) {
      return yield* new ConnectorAuthenticationFailed({
        message: "connector identity does not match the bound Chrome profile",
      });
    }
    return {
      ...identity,
      label: connector.label,
    };
  });
