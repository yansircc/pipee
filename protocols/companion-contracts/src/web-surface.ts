import { Schema } from "effect";
import {
  BrowserCompanionExpectation,
  BrowserCompanionProbe,
} from "@pipee/companion-contracts/browser-companion";

export const WEB_SURFACE_CONTRACT = "pipee/web-surface@2" as const;
export const WEB_SURFACE_RUNTIME_CONTRACT = "pipee/web-surface-runtime@2" as const;
export const WEB_SURFACE_CHANNEL_CONTRACT = "pipee/web-surface-channel@2" as const;

export const JsonValue: Schema.Codec<JsonValue> = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<JsonValue> => JsonValue),
  ),
]);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export const SurfaceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  Schema.brand("SurfaceId"),
);
export type SurfaceId = typeof SurfaceId.Type;

export const CandidateHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("CandidateHash"),
);
export type CandidateHash = typeof CandidateHash.Type;

export const WebSurfaceManifest = Schema.Struct({
  contract: Schema.Literal(WEB_SURFACE_CONTRACT),
  document: Schema.String,
  title: Schema.NonEmptyString,
});
export type WebSurfaceManifest = typeof WebSurfaceManifest.Type;

export const WebSurfaceRuntimeIdentity = Schema.Struct({
  registryId: Schema.String,
  runtimeEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  runtimeId: Schema.String,
});
export type WebSurfaceRuntimeIdentity = typeof WebSurfaceRuntimeIdentity.Type;

export const WebSurfaceProjection = Schema.Struct({
  packageName: Schema.NonEmptyString,
  surfaceId: SurfaceId,
  candidateHash: CandidateHash,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  view: Schema.NullOr(JsonValue),
});
export type WebSurfaceProjection = typeof WebSurfaceProjection.Type;

export const WebSurfaceActionRequest = Schema.Struct({
  requestId: Schema.NonEmptyString,
  payload: JsonValue,
});
export type WebSurfaceActionRequest = typeof WebSurfaceActionRequest.Type;

export const WebSurfaceActionOutcome = Schema.Union([
  Schema.TaggedStruct("Accepted", { payload: JsonValue }),
  Schema.TaggedStruct("Rejected", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("Failed", { message: Schema.NonEmptyString }),
]);
export type WebSurfaceActionOutcome = typeof WebSurfaceActionOutcome.Type;

export const WebSurfaceCatalogItem = Schema.Struct({
  packageName: Schema.NonEmptyString,
  surfaceId: SurfaceId,
  candidateHash: CandidateHash,
  title: Schema.NonEmptyString,
  documentUrl: Schema.String,
  browserCompanion: Schema.optionalKey(BrowserCompanionExpectation),
});
export type WebSurfaceCatalogItem = typeof WebSurfaceCatalogItem.Type;

export const WebSurfaceDiagnostic = Schema.Struct({
  packageName: Schema.optionalKey(Schema.String),
  message: Schema.NonEmptyString,
});

export const WebSurfaceCatalog = Schema.Struct({
  surfaces: Schema.Array(WebSurfaceCatalogItem),
  diagnostics: Schema.Array(WebSurfaceDiagnostic),
});
export type WebSurfaceCatalog = typeof WebSurfaceCatalog.Type;

export const WebSurfaceSessionContext = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  cwd: Schema.String,
  name: Schema.NullOr(Schema.String),
  projectRoot: Schema.NullOr(Schema.String),
  modified: Schema.String,
});
export type WebSurfaceSessionContext = typeof WebSurfaceSessionContext.Type;

export type WebSurfaceDispatch = (
  request: WebSurfaceActionRequest,
  signal: AbortSignal,
) => Promise<WebSurfaceActionOutcome> | WebSurfaceActionOutcome;

export interface WebSurfaceRegistration {
  readonly dispatch: WebSurfaceDispatch;
}

export interface WebSurfaceRuntimeHandle {
  readonly replace: (view?: JsonValue) => void;
  readonly release: () => void;
}

export interface WebSurfaceRuntimePort {
  readonly register: (registration: WebSurfaceRegistration) => WebSurfaceRuntimeHandle;
}

export const WebSurfaceHostMessage = Schema.Union([
  Schema.TaggedStruct("init", {
    contract: Schema.Literal(WEB_SURFACE_CHANNEL_CONTRACT),
    session: WebSurfaceSessionContext,
    runtime: WebSurfaceRuntimeIdentity,
    surface: WebSurfaceProjection,
  }),
  Schema.TaggedStruct("projection", {
    session: WebSurfaceSessionContext,
    runtime: WebSurfaceRuntimeIdentity,
    surface: WebSurfaceProjection,
  }),
  Schema.TaggedStruct("sessions", {
    sessions: Schema.Array(WebSurfaceSessionContext),
    returnSessionId: Schema.optionalKey(Schema.NonEmptyString),
  }),
  Schema.TaggedStruct("session-closed", {
    sessionId: Schema.NonEmptyString,
    reason: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("action-result", {
    requestId: Schema.NonEmptyString,
    outcome: WebSurfaceActionOutcome,
  }),
  Schema.TaggedStruct("confirm-result", {
    requestId: Schema.NonEmptyString,
    confirmed: Schema.Boolean,
  }),
  Schema.TaggedStruct("browser-companion-projection", { projection: BrowserCompanionProbe }),
  Schema.TaggedStruct("host-action-result", {
    requestId: Schema.NonEmptyString,
    accepted: Schema.Boolean,
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("closed", { reason: Schema.NonEmptyString }),
]);
export type WebSurfaceHostMessage = typeof WebSurfaceHostMessage.Type;

export const WebSurfaceClientMessage = Schema.Union([
  Schema.TaggedStruct("ready", { contract: Schema.Literal(WEB_SURFACE_CHANNEL_CONTRACT) }),
  Schema.TaggedStruct("dispatch", {
    requestId: Schema.NonEmptyString,
    sessionId: Schema.NonEmptyString,
    payload: JsonValue,
  }),
  Schema.TaggedStruct("navigate", { path: Schema.NonEmptyString }),
  Schema.TaggedStruct("notify", {
    message: Schema.NonEmptyString,
    level: Schema.Literals(["info", "warning", "error"]),
  }),
  Schema.TaggedStruct("confirm", {
    requestId: Schema.NonEmptyString,
    title: Schema.NonEmptyString,
    message: Schema.String,
  }),
  Schema.TaggedStruct("browser-companion-wake", { requestId: Schema.NonEmptyString }),
  Schema.TaggedStruct("browser-companion-probe", { requestId: Schema.NonEmptyString }),
  Schema.TaggedStruct("browser-companion-download", { requestId: Schema.NonEmptyString }),
  Schema.TaggedStruct("copy-text", { requestId: Schema.NonEmptyString, text: Schema.String }),
]);
export type WebSurfaceClientMessage = typeof WebSurfaceClientMessage.Type;
