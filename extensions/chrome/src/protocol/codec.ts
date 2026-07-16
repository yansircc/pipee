import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BridgeStopped,
  BridgeUnavailable,
  CommandOutcomeUnknown,
  CommandRejected,
  CommandTimeout,
  ConnectorAlreadyBound,
  ConnectorBindingMismatch,
  ConnectorNotBound,
  ConnectorOffline,
  WebConnectorLeaseUnavailable,
  ProtocolFailure,
  messageOf,
  type BridgeFailure,
} from "../core/errors.js";
import {
  BridgeAuthenticationHandshake,
  BridgeStatusResponse,
  ForgetRequest,
  BindingMutationResponse,
  ForwardRequest,
  ForwardResponse,
  InputCall,
  PageCall,
  PairingConfirmRequest,
  PairingConfirmResponse,
  PairingState,
  PollResponse,
  SystemCall,
  SessionWebRouteDetachRequest,
  TabCall,
  UnpairRequest,
  WireDomainRequest,
  WireResult,
  WebRunLeaseAcquireRequest,
  WebRunLeaseReleaseRequest,
  WebRunOffer,
  type SessionContext,
  type WireBridgeFailure,
  type WireCommand,
  type WireCommandTerminalFailure,
} from "./schema.js";
import { atomicToolDescriptor, publicToolCallContract } from "./operation-contract.js";

const failDecode = (label: string) => (cause: unknown) =>
  new ProtocolFailure({ message: `Invalid ${label}`, cause });

const invalidToolCall = (domain: "tab" | "page" | "input") => (cause: unknown) => {
  const contract = publicToolCallContract[domain];
  const detail = messageOf(cause).replaceAll(/\s+/g, " ").slice(0, 800);
  return new ProtocolFailure({
    message: `Invalid chrome_${domain} parameters. Use one top-level op: ${contract.operations.join(", ")}. ${detail} Example: ${JSON.stringify(contract.example)}`,
    cause,
  });
};

const decodeJson = <S extends Schema.Constraint>(label: string, schema: S, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(failDecode(label)),
  );

export const decodeWireResultJson = (text: string) => decodeJson("wire result", WireResult, text);
export const decodeForwardRequestJson = (text: string) =>
  decodeJson("forward request", ForwardRequest, text);
export const decodeForwardResponseJson = (text: string) =>
  decodeJson("forward response", ForwardResponse, text);
export const decodeUnpairRequestJson = (text: string) =>
  decodeJson("unpair request", UnpairRequest, text);
export const decodeUnpairResponseJson = (text: string) =>
  decodeJson("unpair response", BindingMutationResponse, text);
export const decodeForgetRequestJson = (text: string) =>
  decodeJson("forget request", ForgetRequest, text);
export const decodeForgetResponseJson = (text: string) =>
  decodeJson("forget response", BindingMutationResponse, text);
export const decodeWebRunOfferJson = (text: string) =>
  decodeJson("web run offer", WebRunOffer, text);
export const decodeWebRunLeaseAcquireRequestJson = (text: string) =>
  decodeJson("web run lease acquisition", WebRunLeaseAcquireRequest, text);
export const decodeWebRunLeaseReleaseRequestJson = (text: string) =>
  decodeJson("web run lease release", WebRunLeaseReleaseRequest, text);
export const decodeSessionWebRouteDetachRequestJson = (text: string) =>
  decodeJson("session web route detach", SessionWebRouteDetachRequest, text);
export const decodeWebRunLeaseMutationResponseJson = (text: string) =>
  decodeJson("web run lease mutation response", BindingMutationResponse, text);
export const decodePollResponseJson = (text: string) =>
  decodeJson("poll response", PollResponse, text);
export const decodePairingStateJson = (text: string) =>
  decodeJson("pairing state", PairingState, text);
export const decodePairingConfirmRequestJson = (text: string) =>
  decodeJson("pairing confirmation", PairingConfirmRequest, text);
export const decodePairingConfirmResponseJson = (text: string) =>
  decodeJson("pairing response", PairingConfirmResponse, text);
export const decodeBridgeStatusJson = (text: string) =>
  decodeJson("bridge status", BridgeStatusResponse, text);
export const decodeBridgeAuthenticationHandshakeJson = (text: string) =>
  decodeJson("bridge authentication handshake", BridgeAuthenticationHandshake, text);

type CommandTerminalFailure = CommandRejected | CommandOutcomeUnknown;

const toWireCommandTerminalFailure = (
  error: CommandTerminalFailure,
): WireCommandTerminalFailure => {
  switch (error._tag) {
    case "CommandRejected":
      return {
        _tag: error._tag,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    case "CommandOutcomeUnknown":
      return {
        _tag: error._tag,
        message: error.message,
        cause: messageOf(error.cause),
      };
  }
};

export const fromWireCommandTerminalFailure = (
  error: WireCommandTerminalFailure,
): CommandTerminalFailure => {
  switch (error._tag) {
    case "CommandRejected":
      return new CommandRejected(error);
    case "CommandOutcomeUnknown":
      return new CommandOutcomeUnknown(error);
  }
};

export const makeWireFailureResult = (id: string, error: CommandTerminalFailure): WireResult => ({
  id,
  ok: false,
  error: toWireCommandTerminalFailure(error),
});

export const toWireBridgeFailure = (error: BridgeFailure): WireBridgeFailure => {
  switch (error._tag) {
    case "BridgeStopped":
    case "ConnectorNotBound":
      return { _tag: error._tag, message: error.message };
    case "WebConnectorLeaseUnavailable":
      return { _tag: error._tag, pairingId: error.pairingId, message: error.message };
    case "BridgeUnavailable":
      return error.cause === undefined
        ? { _tag: error._tag, message: error.message }
        : { _tag: error._tag, message: error.message, cause: messageOf(error.cause) };
    case "ConnectorOffline":
      return { _tag: error._tag, connectorId: error.connectorId, message: error.message };
    case "ConnectorBindingMismatch":
      return error.actualConnectorId === undefined
        ? {
            _tag: error._tag,
            expectedConnectorId: error.expectedConnectorId,
            message: error.message,
          }
        : {
            _tag: error._tag,
            expectedConnectorId: error.expectedConnectorId,
            actualConnectorId: error.actualConnectorId,
            message: error.message,
          };
    case "ConnectorAlreadyBound":
      return {
        _tag: error._tag,
        actualConnectorId: error.actualConnectorId,
        message: error.message,
      };
    case "CommandTimeout":
      return { _tag: error._tag, message: error.message, timeoutMs: error.timeoutMs };
    case "CommandOutcomeUnknown":
    case "CommandRejected":
      return toWireCommandTerminalFailure(error);
    case "ProtocolFailure":
      return { _tag: error._tag, message: error.message, cause: messageOf(error.cause) };
  }
};

export const fromWireBridgeFailure = (error: WireBridgeFailure): BridgeFailure => {
  switch (error._tag) {
    case "BridgeStopped":
      return new BridgeStopped(error);
    case "BridgeUnavailable":
      return new BridgeUnavailable(error);
    case "ConnectorNotBound":
      return new ConnectorNotBound(error);
    case "WebConnectorLeaseUnavailable":
      return new WebConnectorLeaseUnavailable(error);
    case "ConnectorOffline":
      return new ConnectorOffline(error);
    case "ConnectorBindingMismatch":
      return new ConnectorBindingMismatch(error);
    case "ConnectorAlreadyBound":
      return new ConnectorAlreadyBound(error);
    case "CommandTimeout":
      return new CommandTimeout(error);
    case "CommandOutcomeUnknown":
    case "CommandRejected":
      return fromWireCommandTerminalFailure(error);
    case "ProtocolFailure":
      return new ProtocolFailure(error);
  }
};

const callSchemas = {
  tab: TabCall,
  page: PageCall,
  input: InputCall,
  system: SystemCall,
} as const;

export type DomainRequest =
  | {
      readonly domain: "tab";
      readonly call: Schema.Schema.Type<typeof TabCall>;
    }
  | {
      readonly domain: "page";
      readonly call: Schema.Schema.Type<typeof PageCall>;
    }
  | {
      readonly domain: "input";
      readonly call: Schema.Schema.Type<typeof InputCall>;
    }
  | {
      readonly domain: "system";
      readonly call: Schema.Schema.Type<typeof SystemCall>;
    };

export const decodeDomainRequest = (
  domain: keyof typeof callSchemas,
  input: unknown,
): Effect.Effect<DomainRequest, ProtocolFailure> =>
  Schema.decodeUnknownEffect(callSchemas[domain])(input).pipe(
    Effect.map((call) => ({ domain, call }) as DomainRequest),
    Effect.mapError(domain === "system" ? failDecode(`${domain} call`) : invalidToolCall(domain)),
  );

export const decodeAtomicToolRequest = (
  toolName: string,
  input: unknown,
): Effect.Effect<DomainRequest, ProtocolFailure> => {
  const descriptor = atomicToolDescriptor(toolName);
  if (!descriptor) {
    return Effect.fail(
      new ProtocolFailure({
        message: `Unknown Chrome tool ${toolName}`,
        cause: toolName,
      }),
    );
  }
  return Schema.decodeUnknownEffect(descriptor.parameters)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolFailure({
          message: `Invalid ${toolName} parameters. ${messageOf(cause).replaceAll(/\s+/g, " ").slice(0, 800)}`,
          cause,
        }),
    ),
    Effect.flatMap((parameters) =>
      decodeDomainRequest(
        descriptor.domain,
        descriptor.projectInput(parameters as Readonly<Record<string, unknown>>),
      ),
    ),
  );
};

export const makeWireCommand = (
  id: string,
  request: WireDomainRequest,
  session: SessionContext,
): WireCommand => ({ id, session, ...request }) as WireCommand;

export const projectDomainRequest = (request: DomainRequest): WireDomainRequest =>
  Schema.decodeUnknownSync(WireDomainRequest, { onExcessProperty: "ignore" })(request);
