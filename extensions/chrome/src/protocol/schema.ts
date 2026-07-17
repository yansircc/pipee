import * as Schema from "effect/Schema";
import { MAX_ADMITTED_COMMANDS_PER_CONNECTOR } from "./bridge-contract.js";
import { HEX_256_PATTERN } from "./hex-256.js";
import { JsonValue } from "./json-value.js";
import {
  ElementTarget as ElementTargetSchema,
  InputCall as WireInputCallSchema,
  PageCall as WirePageCallSchema,
  PointerTarget as PointerTargetSchema,
  SystemCall as SystemCallSchema,
  TabCall as TabCallSchema,
  Target as TargetSchema,
  ToolInputCall as InputCallSchema,
  ToolPageCall as PageCallSchema,
} from "./operation-contract.js";

export const Target = TargetSchema;
export const ElementTarget = ElementTargetSchema;
export const PointerTarget = PointerTargetSchema;
export const TabCall = TabCallSchema;
export const PageCall = PageCallSchema;
export const InputCall = InputCallSchema;
export const WirePageCall = WirePageCallSchema;
export const SystemCall = SystemCallSchema;

const optional = Schema.optionalKey;
const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const SessionGroupTitle = NonBlankString.check(Schema.isMaxLength(80));
const ConnectorId = Schema.String.check(Schema.isUUID(4));
const ChromeExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
const ConnectorSecret = Schema.String.check(Schema.isPattern(HEX_256_PATTERN));
const ConnectorLabel = NonBlankString.check(Schema.isMaxLength(80));
const DisplayVersion = NonBlankString.check(Schema.isMaxLength(64));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AdmittedCommandCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_ADMITTED_COMMANDS_PER_CONNECTOR }),
);
const Timestamp = NonNegativeInt;
export const ProtocolFingerprint = Schema.String.check(Schema.isPattern(HEX_256_PATTERN));
const OwnerAuthenticationToken = Schema.String.check(Schema.isPattern(HEX_256_PATTERN));
const ForwardTimeoutMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 }));

export const SessionContext = Schema.Struct({
  key: NonBlankString,
  groupTitle: SessionGroupTitle,
  foreground: Schema.Boolean,
});

export const ConnectorIdentity = Schema.Struct({
  connectorId: ConnectorId,
  secret: ConnectorSecret,
  label: ConnectorLabel,
});

export const ConnectorRouteIdentity = Schema.Struct({
  connectorId: ConnectorId,
  extensionId: ChromeExtensionId,
  extensionDisplayVersion: DisplayVersion,
  protocolFingerprint: ProtocolFingerprint,
});

export const ProfileConnector = Schema.Struct({
  ...ConnectorIdentity.fields,
  ...ConnectorRouteIdentity.fields,
});

export const PublicConnector = Schema.Struct({
  ...ConnectorRouteIdentity.fields,
  label: ConnectorLabel,
});

const ConnectorCommandCountFields = {
  queuedCommands: AdmittedCommandCount,
  pendingCommands: AdmittedCommandCount,
};
const admittedCommandCount = Schema.makeFilter(
  (status: { readonly queuedCommands: number; readonly pendingCommands: number }) =>
    status.queuedCommands + status.pendingCommands <= MAX_ADMITTED_COMMANDS_PER_CONNECTOR
      ? undefined
      : `queuedCommands + pendingCommands exceeds ${MAX_ADMITTED_COMMANDS_PER_CONNECTOR}`,
);

const ConnectorStatus = Schema.Struct({
  ...PublicConnector.fields,
  connected: Schema.Boolean,
  lastSeenAt: optional(Timestamp),
  ...ConnectorCommandCountFields,
}).check(admittedCommandCount);

const BridgeStatusFields = {
  url: Schema.String,
  mode: Schema.Literals(["server", "client", "stopped", "closed"]),
  extensionExpectation: Schema.Struct({
    extensionId: ChromeExtensionId,
    displayVersion: DisplayVersion,
    protocolFingerprint: ProtocolFingerprint,
  }),
};

export const BridgeStatusResponse = Schema.Struct({
  ...BridgeStatusFields,
  connector: optional(ConnectorStatus),
});

const CommandEnvelopeFields = {
  id: NonBlankString,
  session: SessionContext,
};

export const WireDomainRequest = Schema.Union([
  Schema.Struct({
    domain: Schema.Literal("tab"),
    call: TabCallSchema,
  }),
  Schema.Struct({
    domain: Schema.Literal("page"),
    call: WirePageCallSchema,
  }),
  Schema.Struct({
    domain: Schema.Literal("input"),
    call: WireInputCallSchema,
  }),
  Schema.Struct({
    domain: Schema.Literal("system"),
    call: SystemCallSchema,
  }),
]);

export const WireCommand = WireDomainRequest.mapMembers((members) =>
  members.map((member) => Schema.Struct({ ...CommandEnvelopeFields, ...member.fields })),
);

const WireCommandRejected = Schema.Struct({
  _tag: Schema.Literal("CommandRejected"),
  code: Schema.String,
  message: Schema.String,
  details: optional(JsonValue),
});

const WireCommandOutcomeUnknown = Schema.Struct({
  _tag: Schema.Literal("CommandOutcomeUnknown"),
  message: Schema.String,
  cause: Schema.String,
});

export const WireCommandTerminalFailure = Schema.Union([
  WireCommandRejected,
  WireCommandOutcomeUnknown,
]);

export const WireResult = Schema.Union([
  Schema.Struct({
    id: NonBlankString,
    ok: Schema.Literal(true),
    value: JsonValue,
  }),
  Schema.Struct({
    id: NonBlankString,
    ok: Schema.Literal(false),
    error: WireCommandTerminalFailure,
  }),
]);

const ForwardEnvelopeFields = {
  session: SessionContext,
  timeoutMs: ForwardTimeoutMs,
};

export const ForwardRequest = WireDomainRequest.mapMembers((members) =>
  members.map((member) => Schema.Struct({ ...ForwardEnvelopeFields, ...member.fields })),
);

export const WireBridgeFailure = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("BridgeStopped"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("BridgeUnavailable"),
    message: Schema.String,
    cause: optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("ConnectorNotBound"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectorOffline"),
    connectorId: ConnectorId,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("CommandTimeout"),
    message: Schema.String,
    timeoutMs: ForwardTimeoutMs,
  }),
  WireCommandOutcomeUnknown,
  WireCommandRejected,
  Schema.Struct({
    _tag: Schema.Literal("ProtocolFailure"),
    message: Schema.String,
    cause: Schema.String,
  }),
]);

export const ForwardResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: WireBridgeFailure }),
]);

export const BridgeAuthenticationHandshake = Schema.Struct({
  bridgeDisplayVersion: DisplayVersion,
  protocolFingerprint: ProtocolFingerprint,
  bridgeEpoch: OwnerAuthenticationToken,
  requestNonce: OwnerAuthenticationToken,
  proof: OwnerAuthenticationToken,
});

export const PollResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("incompatible"),
    expectedExtensionId: ChromeExtensionId,
    expectedExtensionDisplayVersion: DisplayVersion,
    actualExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
    actualProtocolFingerprint: ProtocolFingerprint,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: WireCommand,
    expectedExtensionId: ChromeExtensionId,
    expectedExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
  }),
  Schema.Struct({
    type: Schema.Literal("none"),
    expectedExtensionId: ChromeExtensionId,
    expectedExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
  }),
]);

export const WireProtocolContract = Schema.Struct({
  bridgeStatus: BridgeStatusResponse,
  wireCommand: WireCommand,
  wireResult: WireResult,
  forwardRequest: ForwardRequest,
  forwardResponse: ForwardResponse,
  bridgeAuthenticationHandshake: BridgeAuthenticationHandshake,
  pollResponse: PollResponse,
});

export type Target = Schema.Schema.Type<typeof TargetSchema>;
export type ElementTarget = Schema.Schema.Type<typeof ElementTargetSchema>;
export type PointerTarget = Schema.Schema.Type<typeof PointerTargetSchema>;
export type TabCall = Schema.Schema.Type<typeof TabCallSchema>;
export type PageCall = Schema.Schema.Type<typeof PageCallSchema>;
export type InputCall = Schema.Schema.Type<typeof InputCallSchema>;
export type WirePageCall = Schema.Schema.Type<typeof WirePageCallSchema>;
export type SessionContext = Schema.Schema.Type<typeof SessionContext>;
export type ConnectorIdentity = Schema.Schema.Type<typeof ConnectorIdentity>;
export type ConnectorRouteIdentity = Schema.Schema.Type<typeof ConnectorRouteIdentity>;
export type ProfileConnector = Schema.Schema.Type<typeof ProfileConnector>;
export type PublicConnector = Schema.Schema.Type<typeof PublicConnector>;
export type ConnectorStatus = Schema.Schema.Type<typeof ConnectorStatus>;
export type BridgeStatusResponse = Schema.Schema.Type<typeof BridgeStatusResponse>;
export type SystemCall = Schema.Schema.Type<typeof SystemCallSchema>;
export type WireDomainRequest = Schema.Schema.Type<typeof WireDomainRequest>;
export type WireCommand = Schema.Schema.Type<typeof WireCommand>;
export type WireCommandTerminalFailure = Schema.Schema.Type<typeof WireCommandTerminalFailure>;
export type WireResult = Schema.Schema.Type<typeof WireResult>;
export type ForwardRequest = Schema.Schema.Type<typeof ForwardRequest>;
export type WireBridgeFailure = Schema.Schema.Type<typeof WireBridgeFailure>;
export type ForwardResponse = Schema.Schema.Type<typeof ForwardResponse>;
export type BridgeAuthenticationHandshake = Schema.Schema.Type<
  typeof BridgeAuthenticationHandshake
>;
export type PollResponse = Schema.Schema.Type<typeof PollResponse>;
export type ProtocolFingerprint = Schema.Schema.Type<typeof ProtocolFingerprint>;

export const toJsonSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.toJsonSchemaDocument(schema).schema;
