import { Schema } from "effect"

export const ChromeExtensionExpectation = Schema.Struct({
  extensionId: Schema.NonEmptyString,
  displayVersion: Schema.NonEmptyString,
  protocolFingerprint: Schema.NonEmptyString,
})
export type ChromeExtensionExpectation = typeof ChromeExtensionExpectation.Type

export const ChromeExtensionEvidence = Schema.Struct({
  ...ChromeExtensionExpectation.fields,
  connectorIdentity: Schema.Struct({
    connectorId: Schema.NonEmptyString,
    connectorLabel: Schema.NonEmptyString,
  }),
})
export type ChromeExtensionEvidence = typeof ChromeExtensionEvidence.Type

export interface ChromeConnectorEvidenceSource {
  readonly connectorId: string
  readonly label: string
  readonly extensionId: string
  readonly extensionDisplayVersion: string
  readonly protocolFingerprint: string
}

export const projectChromeExtensionEvidence = (
  connector: ChromeConnectorEvidenceSource,
): ChromeExtensionEvidence => ({
  extensionId: connector.extensionId,
  displayVersion: connector.extensionDisplayVersion,
  protocolFingerprint: connector.protocolFingerprint,
  connectorIdentity: {
    connectorId: connector.connectorId,
    connectorLabel: connector.label,
  },
})

export const ChromeExternalRequest = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("pi-chrome/web-run/status") }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("pi-chrome/web-run/prepare") }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("pi-chrome/web-run/complete"),
    pairingId: Schema.NonEmptyString,
  }),
])
export type ChromeExternalRequest = typeof ChromeExternalRequest.Type

export const ChromeExternalSuccess = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ok: Schema.Literal(true), type: Schema.Literal("Status"), evidence: ChromeExtensionEvidence }),
  Schema.Struct({
    version: Schema.Literal(1),
    ok: Schema.Literal(true),
    type: Schema.Literal("Prepared"),
    evidence: ChromeExtensionEvidence,
    pairingId: Schema.NonEmptyString,
    offer: Schema.NonEmptyString,
  }),
  Schema.Struct({ version: Schema.Literal(1), ok: Schema.Literal(true), type: Schema.Literal("Completed"), evidence: ChromeExtensionEvidence }),
])

export const ChromeExternalError = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.NonEmptyString, message: Schema.NonEmptyString }),
})

export const ChromeExternalResponse = Schema.Union([ChromeExternalSuccess, ChromeExternalError])
export type ChromeExternalResponse = typeof ChromeExternalResponse.Type

export const ChromeCompatibilityMismatch = Schema.Literals([
  "ExtensionId",
  "DisplayVersion",
  "ProtocolFingerprint",
])

export const ChromeCompatibility = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Verified", { evidence: ChromeExtensionEvidence }),
  Schema.TaggedStruct("Incompatible", {
    expected: ChromeExtensionExpectation,
    actual: ChromeExtensionEvidence,
    mismatches: Schema.Array(ChromeCompatibilityMismatch),
  }),
])
export type ChromeCompatibility = typeof ChromeCompatibility.Type
export type ChromeKnownCompatibility = Exclude<
  ChromeCompatibility,
  { readonly _tag: "Unknown" }
>

export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation,
  actual: ChromeExtensionEvidence,
): ChromeKnownCompatibility
export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation | null,
  actual: ChromeExtensionEvidence | null,
): ChromeCompatibility
export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation | null,
  actual: ChromeExtensionEvidence | null,
): ChromeCompatibility {
  if (expected === null || actual === null) return { _tag: "Unknown" }
  const mismatches: Array<typeof ChromeCompatibilityMismatch.Type> = []
  if (expected.extensionId !== actual.extensionId) mismatches.push("ExtensionId")
  if (expected.displayVersion !== actual.displayVersion) mismatches.push("DisplayVersion")
  if (expected.protocolFingerprint !== actual.protocolFingerprint) mismatches.push("ProtocolFingerprint")
  return mismatches.length === 0
    ? { _tag: "Verified", evidence: actual }
    : { _tag: "Incompatible", expected, actual, mismatches }
}

export const classifyChromeConnectorCompatibility = (
  expected: ChromeExtensionExpectation,
  connector: ChromeConnectorEvidenceSource,
): ChromeKnownCompatibility =>
  classifyChromeCompatibility(expected, projectChromeExtensionEvidence(connector))

export const ChromeProtocolRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("ProtocolCompatible"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("ProtocolCompatible"),
    satisfied: Schema.Literal(false),
    expectedVersion: Schema.String,
    actualVersion: Schema.String,
    mismatches: Schema.optionalKey(Schema.Array(ChromeCompatibilityMismatch)),
    remediation: Schema.Struct({
      type: Schema.Literal("ReloadUnpackedExtension"),
      extensionId: Schema.String,
      directory: Schema.String,
    }),
  }),
])

export const ChromeConnectorRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("ConnectorLive"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("ConnectorLive"),
    satisfied: Schema.Literal(false),
    remediation: Schema.Struct({
      type: Schema.Literal("OpenChromeProfile"),
      connectorId: Schema.optionalKey(Schema.String),
      connectorLabel: Schema.optionalKey(Schema.String),
    }),
  }),
])

export const ChromeAuthorizationRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("Authorized"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("Authorized"),
    satisfied: Schema.Literal(false),
    remediation: Schema.Struct({ type: Schema.Literal("AuthorizeSession") }),
  }),
])

export const ChromeStatusRequirement = Schema.Union([
  ChromeProtocolRequirement,
  ChromeConnectorRequirement,
  ChromeAuthorizationRequirement,
])
export type ChromeStatusRequirement = typeof ChromeStatusRequirement.Type

export const ChromeStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-chrome/status"),
  version: Schema.Literal(2),
  readiness: Schema.Literals(["ready", "offline", "locked", "error"]),
  authorization: Schema.Union([
    Schema.Literals(["indefinite", "locked"]),
    Schema.Struct({ expiresAt: Schema.Number }),
  ]),
  connection: Schema.Literals(["connected", "offline", "unavailable", "unpaired", "unknown"]),
  bridge: Schema.Literals(["running", "stopped", "error"]),
  connectorId: Schema.optionalKey(Schema.String),
  connectorLabel: Schema.optionalKey(Schema.String),
  connectorExpiresAt: Schema.optionalKey(Schema.Number),
  errorMessage: Schema.optionalKey(Schema.String),
  requirements: Schema.Array(ChromeStatusRequirement),
})
export type ChromeStatusProjection = typeof ChromeStatusProjection.Type

export const ChromeControlRequest = Schema.Struct({
  action: Schema.Union([
    Schema.TaggedStruct("Authorize", {}),
    Schema.TaggedStruct("Revoke", {}),
    Schema.TaggedStruct("WebAttach", { offer: Schema.NonEmptyString }),
    Schema.TaggedStruct("WebAssert", { pairingId: Schema.NonEmptyString }),
    Schema.TaggedStruct("WebDetach", { pairingId: Schema.NonEmptyString }),
  ]),
})
export type ChromeControlRequest = typeof ChromeControlRequest.Type
