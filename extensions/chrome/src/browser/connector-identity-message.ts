import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ProfileConnector as ProfileConnectorSchema,
  type ProfileConnector,
} from "../protocol/schema.js";

export type ConnectorIdentityRequest =
  | { readonly type: "pi-chrome/connector/load" }
  | { readonly type: "pi-chrome/connector/rename"; readonly label: string };

export type ConnectorIdentityResponse =
  | { readonly ok: true; readonly connector: ProfileConnector }
  | { readonly ok: false; readonly error: string };

export class ConnectorIdentityMessageFailure extends Data.TaggedError(
  "ConnectorIdentityMessageFailure",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const isConnectorIdentityRequest = (value: unknown): value is ConnectorIdentityRequest => {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "pi-chrome/connector/load") return true;
  return (
    value.type === "pi-chrome/connector/rename" &&
    "label" in value &&
    typeof value.label === "string"
  );
};

export const requestConnectorIdentity = (
  request: ConnectorIdentityRequest,
): Effect.Effect<ProfileConnector, ConnectorIdentityMessageFailure> =>
  Effect.tryPromise({
    try: () => chrome.runtime.sendMessage(request) as Promise<unknown>,
    catch: (cause) =>
      new ConnectorIdentityMessageFailure({
        message: "Could not reach the connector identity owner",
        cause,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new ConnectorIdentityMessageFailure({
            message: "Timed out waiting for the connector identity owner",
          }),
        ),
    }),
    Effect.flatMap((response) => {
      if (typeof response !== "object" || response === null || !("ok" in response)) {
        return Effect.fail(
          new ConnectorIdentityMessageFailure({
            message: "Connector identity owner returned an invalid response",
          }),
        );
      }
      if (response.ok === false && "error" in response) {
        return Effect.fail(
          new ConnectorIdentityMessageFailure({ message: String(response.error) }),
        );
      }
      if (response.ok !== true || !("connector" in response)) {
        return Effect.fail(
          new ConnectorIdentityMessageFailure({
            message: "Connector identity owner returned an invalid response",
          }),
        );
      }
      return Schema.decodeUnknownEffect(ProfileConnectorSchema)(response.connector).pipe(
        Effect.mapError(
          (cause) =>
            new ConnectorIdentityMessageFailure({
              message: "Connector identity owner returned an invalid connector",
              cause,
            }),
        ),
      );
    }),
  );
