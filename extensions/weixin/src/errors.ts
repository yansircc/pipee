import { Data } from "effect";

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  readonly operation: "read" | "write" | "decode" | "encode";
  readonly path: string;
  readonly cause: unknown;
}> {}

export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  readonly operation: string;
  readonly url: string;
  readonly cause: unknown;
  readonly status?: number;
  readonly responseBody?: unknown;
}> {}

export class IlinkProtocolError extends Data.TaggedError("IlinkProtocolError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class IlinkSessionExpiredError extends Data.TaggedError("IlinkSessionExpiredError")<{
  readonly operation: string;
  readonly code: -14;
  readonly cause: unknown;
}> {}

export class IlinkMediaError extends Data.TaggedError("IlinkMediaError")<{
  readonly operation: "download" | "decrypt" | "decode";
  readonly reason: "InvalidReference" | "InvalidKey" | "InvalidContent";
  readonly cause: unknown;
}> {}

export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

export class GatewayIdempotencyConflictError extends Data.TaggedError(
  "GatewayIdempotencyConflictError",
)<{
  readonly sessionId: string;
  readonly requestId: string;
  readonly reason: "PayloadMismatch" | "InDoubt";
}> {}

export class BridgeConfigurationError extends Data.TaggedError("BridgeConfigurationError")<{
  readonly reason: string;
}> {}

export class BridgeOwnershipConflict extends Data.TaggedError("BridgeOwnershipConflict")<{
  readonly resource: "state" | "account";
}> {}

export class BridgeBusy extends Data.TaggedError("BridgeBusy")<{
  readonly operation: "login";
  readonly ownerSessionId: string;
}> {}

export class QrCodeError extends Data.TaggedError("QrCodeError")<{
  readonly cause: unknown;
}> {}
