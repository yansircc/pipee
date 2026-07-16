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
export const Timestamp = NonNegativeInt;
const PairingCapability = Schema.String.check(Schema.isPattern(/^[A-F0-9]{32}$/));
export const PairingId = Schema.String.check(Schema.isUUID(4));
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

export const BoundConnector = Schema.Struct({
  ...ProfileConnector.fields,
  pairedAt: Timestamp,
});

export const PublicConnector = Schema.Struct({
  ...ConnectorRouteIdentity.fields,
  label: ConnectorLabel,
});

export const PublicBoundConnector = Schema.Struct({
  ...PublicConnector.fields,
  pairedAt: Timestamp,
});

export const WebRunOffer = Schema.Struct({
  version: Schema.Literal(1),
  pairingId: PairingId,
  capability: PairingCapability,
  expiresAt: Timestamp,
  connector: PublicConnector,
});

export const WebRunLeaseClaim = Schema.Struct({
  pairingId: PairingId,
  leaseToken: OwnerAuthenticationToken,
  connectorId: ConnectorId,
  sessionKey: NonBlankString,
});

export const WebRunLeaseAcquireRequest = Schema.Struct({
  offer: WebRunOffer,
  claim: WebRunLeaseClaim,
});

export const WebRunLeaseReleaseRequest = Schema.Struct({ claim: WebRunLeaseClaim });

export const SessionWebRouteDetachRequest = Schema.Struct({
  sessionKey: NonBlankString,
  generation: PairingId,
});

const SessionWebRouteFields = {
  source: Schema.Literal("web"),
  sessionKey: NonBlankString,
  generation: PairingId,
  connector: PublicConnector,
};

export const SessionWebRouteStatus = Schema.Union([
  Schema.Struct({
    ...SessionWebRouteFields,
    availability: Schema.Literal("live"),
    claim: WebRunLeaseClaim,
    expiresAt: Timestamp,
    connected: Schema.Boolean,
  }).check(
    Schema.makeFilter((route) => {
      if (route.claim.sessionKey !== route.sessionKey) {
        return "live session route claim belongs to another session";
      }
      if (route.claim.pairingId !== route.generation) {
        return "live session route claim belongs to another generation";
      }
      return route.claim.connectorId !== route.connector.connectorId
        ? "live session route claim belongs to another connector"
        : undefined;
    }),
  ),
  Schema.Struct({
    ...SessionWebRouteFields,
    availability: Schema.Literal("expired"),
    connected: Schema.Literal(false),
    claim: optional(Schema.Never),
    expiresAt: optional(Schema.Never),
  }),
]);

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

const NeverSeenConnectorStatus = Schema.Struct({
  connectorId: ConnectorId,
  connected: Schema.Literal(false),
  lastSeenAt: optional(Schema.Never),
  label: optional(Schema.Never),
  extensionId: optional(Schema.Never),
  extensionDisplayVersion: optional(Schema.Never),
  protocolFingerprint: optional(Schema.Never),
  ...ConnectorCommandCountFields,
}).check(
  admittedCommandCount,
  Schema.makeFilter((status) =>
    status.queuedCommands === 0 && status.pendingCommands === 0
      ? undefined
      : "a connector without a lease cannot have admitted commands",
  ),
);

const SeenConnectorStatus = Schema.Struct({
  ...PublicConnector.fields,
  connected: Schema.Boolean,
  lastSeenAt: Timestamp,
  ...ConnectorCommandCountFields,
}).check(admittedCommandCount);

export const ConnectorStatus = Schema.Union([NeverSeenConnectorStatus, SeenConnectorStatus]);

const BridgeStatusFields = {
  url: Schema.String,
  mode: Schema.Literals(["server", "client", "stopped", "closed"]),
  sessionRoutes: Schema.Array(SessionWebRouteStatus),
  protocolCompatibility: Schema.Union([
    Schema.Struct({
      compatible: Schema.Literal(true),
      expectedExtensionDisplayVersion: DisplayVersion,
    }),
    Schema.Struct({
      compatible: Schema.Literal(false),
      extensionId: ChromeExtensionId,
      expectedExtensionDisplayVersion: DisplayVersion,
      actualExtensionDisplayVersion: DisplayVersion,
    }),
  ]),
};

export const BridgeStatusResponse = Schema.Union([
  Schema.Struct({
    ...BridgeStatusFields,
    binding: optional(Schema.Never),
    connector: optional(Schema.Never),
  }),
  Schema.Struct({
    ...BridgeStatusFields,
    binding: PublicBoundConnector,
    connector: ConnectorStatus,
  }).check(
    Schema.makeFilter((status) => {
      if (status.connector.connectorId !== status.binding.connectorId) {
        return "bridge binding and connector status refer to different connector ids";
      }
      if (
        status.connector.extensionId !== undefined &&
        status.connector.extensionId !== status.binding.extensionId
      ) {
        return "bridge binding and connector status refer to different extension ids";
      }
      return status.connector.label !== undefined && status.connector.label !== status.binding.label
        ? "bridge binding and connector status use different labels"
        : undefined;
    }),
  ),
]);

export const PairingExpectation = Schema.Struct({
  expectedExtensionId: ChromeExtensionId,
  expectedExtensionDisplayVersion: DisplayVersion,
  expectedProtocolFingerprint: ProtocolFingerprint,
});

export const PairingState = Schema.Struct({
  type: Schema.Literal("pending"),
  challenge: PairingCapability,
  expiresAt: Timestamp,
  ...PairingExpectation.fields,
});

export const PairingConfirmRequest = Schema.Struct({ connector: ProfileConnector });

export const PairingConfirmResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), connector: PublicConnector }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

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

export const ConnectorSelection = Schema.Union([
  Schema.Struct({ source: Schema.Literal("terminal"), expectedConnectorId: ConnectorId }),
  Schema.Struct({ source: Schema.Literal("web"), claim: WebRunLeaseClaim }),
]);

const ForwardEnvelopeFields = {
  connector: ConnectorSelection,
  session: SessionContext,
  timeoutMs: ForwardTimeoutMs,
};

export const ForwardRequest = WireDomainRequest.mapMembers((members) =>
  members.map((member) => Schema.Struct({ ...ForwardEnvelopeFields, ...member.fields })),
);

export const UnpairRequest = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("bound"),
    expectedConnectorId: ConnectorId,
    session: SessionContext,
    timeoutMs: ForwardTimeoutMs,
  }),
  Schema.Struct({ state: Schema.Literal("unbound") }),
]);

export const ForgetRequest = Schema.Struct({
  expectedConnectorId: ConnectorId,
});

export const WireBridgeFailure = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("BridgeStopped"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("BridgeUnavailable"),
    message: Schema.String,
    cause: optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("ConnectorNotBound"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("WebConnectorLeaseUnavailable"),
    pairingId: PairingId,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectorOffline"),
    connectorId: ConnectorId,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectorBindingMismatch"),
    expectedConnectorId: ConnectorId,
    actualConnectorId: optional(ConnectorId),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectorAlreadyBound"),
    actualConnectorId: ConnectorId,
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

export const BindingMutationResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
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
    expectedExtensionDisplayVersion: DisplayVersion,
    actualExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
    actualProtocolFingerprint: ProtocolFingerprint,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: WireCommand,
    expectedExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
  }),
  Schema.Struct({
    type: Schema.Literal("none"),
    expectedExtensionDisplayVersion: DisplayVersion,
    expectedProtocolFingerprint: ProtocolFingerprint,
  }),
]);

export const WireProtocolContract = Schema.Struct({
  bridgeStatus: BridgeStatusResponse,
  pairingState: PairingState,
  pairingConfirmRequest: PairingConfirmRequest,
  pairingConfirmResponse: PairingConfirmResponse,
  wireCommand: WireCommand,
  wireResult: WireResult,
  forwardRequest: ForwardRequest,
  forwardResponse: ForwardResponse,
  unpairRequest: UnpairRequest,
  unpairResponse: BindingMutationResponse,
  forgetRequest: ForgetRequest,
  forgetResponse: BindingMutationResponse,
  webRunOffer: WebRunOffer,
  webRunLeaseAcquireRequest: WebRunLeaseAcquireRequest,
  webRunLeaseAcquireResponse: BindingMutationResponse,
  webRunLeaseReleaseRequest: WebRunLeaseReleaseRequest,
  webRunLeaseReleaseResponse: BindingMutationResponse,
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
export type BoundConnector = Schema.Schema.Type<typeof BoundConnector>;
export type PublicConnector = Schema.Schema.Type<typeof PublicConnector>;
export type PublicBoundConnector = Schema.Schema.Type<typeof PublicBoundConnector>;
export type WebRunOffer = Schema.Schema.Type<typeof WebRunOffer>;
export type WebRunLeaseClaim = Schema.Schema.Type<typeof WebRunLeaseClaim>;
export type WebRunLeaseAcquireRequest = Schema.Schema.Type<typeof WebRunLeaseAcquireRequest>;
export type WebRunLeaseReleaseRequest = Schema.Schema.Type<typeof WebRunLeaseReleaseRequest>;
export type SessionWebRouteDetachRequest = Schema.Schema.Type<typeof SessionWebRouteDetachRequest>;
export type SessionWebRouteStatus = Schema.Schema.Type<typeof SessionWebRouteStatus>;
export type ConnectorSelection = Schema.Schema.Type<typeof ConnectorSelection>;
export type ConnectorStatus = Schema.Schema.Type<typeof ConnectorStatus>;
export type BridgeStatusResponse = Schema.Schema.Type<typeof BridgeStatusResponse>;
export type PairingExpectation = Schema.Schema.Type<typeof PairingExpectation>;
export type PairingState = Schema.Schema.Type<typeof PairingState>;
export type PairingConfirmRequest = Schema.Schema.Type<typeof PairingConfirmRequest>;
export type PairingConfirmResponse = Schema.Schema.Type<typeof PairingConfirmResponse>;
export type SystemCall = Schema.Schema.Type<typeof SystemCallSchema>;
export type WireDomainRequest = Schema.Schema.Type<typeof WireDomainRequest>;
export type WireCommand = Schema.Schema.Type<typeof WireCommand>;
export type WireCommandTerminalFailure = Schema.Schema.Type<typeof WireCommandTerminalFailure>;
export type WireResult = Schema.Schema.Type<typeof WireResult>;
export type ForwardRequest = Schema.Schema.Type<typeof ForwardRequest>;
export type WireBridgeFailure = Schema.Schema.Type<typeof WireBridgeFailure>;
export type ForwardResponse = Schema.Schema.Type<typeof ForwardResponse>;
export type UnpairRequest = Schema.Schema.Type<typeof UnpairRequest>;
export type ForgetRequest = Schema.Schema.Type<typeof ForgetRequest>;
export type BridgeAuthenticationHandshake = Schema.Schema.Type<
  typeof BridgeAuthenticationHandshake
>;
export type PollResponse = Schema.Schema.Type<typeof PollResponse>;
export type ProtocolFingerprint = Schema.Schema.Type<typeof ProtocolFingerprint>;

export const toJsonSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.toJsonSchemaDocument(schema).schema;
