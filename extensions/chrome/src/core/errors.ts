import * as Data from "effect/Data";
import type { JsonValue } from "../protocol/json-value.js";

export class BridgeStopped extends Data.TaggedError("BridgeStopped")<{
  readonly message: string;
}> {}

export class BridgeBindFailed extends Data.TaggedError("BridgeBindFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class BridgeUnavailable extends Data.TaggedError("BridgeUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BridgeOwnerUnreachable extends Data.TaggedError("BridgeOwnerUnreachable")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ConnectorNotBound extends Data.TaggedError("ConnectorNotBound")<{
  readonly message: string;
}> {}

export class WebConnectorLeaseUnavailable extends Data.TaggedError("WebConnectorLeaseUnavailable")<{
  readonly pairingId: string;
  readonly message: string;
}> {}

export class ConnectorOffline extends Data.TaggedError("ConnectorOffline")<{
  readonly connectorId: string;
  readonly message: string;
}> {}

export class ConnectorBindingMismatch extends Data.TaggedError("ConnectorBindingMismatch")<{
  readonly expectedConnectorId: string;
  readonly actualConnectorId?: string;
  readonly message: string;
}> {}

export class ConnectorAlreadyBound extends Data.TaggedError("ConnectorAlreadyBound")<{
  readonly actualConnectorId: string;
  readonly message: string;
}> {}

export class ConnectorAuthenticationFailed extends Data.TaggedError(
  "ConnectorAuthenticationFailed",
)<{
  readonly message: string;
}> {}

export class PairingUnavailable extends Data.TaggedError("PairingUnavailable")<{
  readonly message: string;
}> {}

export class CommandTimeout extends Data.TaggedError("CommandTimeout")<{
  readonly message: string;
  readonly timeoutMs: number;
}> {}

export class CommandOutcomeUnknown extends Data.TaggedError("CommandOutcomeUnknown")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class CommandRejected extends Data.TaggedError("CommandRejected")<{
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}> {}

export class ProtocolFailure extends Data.TaggedError("ProtocolFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ScreenshotFailure extends Data.TaggedError("ScreenshotFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AuthorizationFailure extends Data.TaggedError("AuthorizationFailure")<{
  readonly message: string;
}> {}

export type BridgeFailure =
  | BridgeStopped
  | BridgeUnavailable
  | ConnectorNotBound
  | WebConnectorLeaseUnavailable
  | ConnectorOffline
  | ConnectorBindingMismatch
  | ConnectorAlreadyBound
  | CommandTimeout
  | CommandOutcomeUnknown
  | CommandRejected
  | ProtocolFailure;

export const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
