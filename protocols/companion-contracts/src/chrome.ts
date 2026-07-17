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

export const ChromeStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-chrome/status"),
  version: Schema.Literal(3),
  state: Schema.Literals(["ready", "waiting-for-extension", "offline", "error"]),
  bridge: Schema.Literals(["running", "stopped", "error"]),
  connector: Schema.optionalKey(
    Schema.Struct({
      id: Schema.NonEmptyString,
      label: Schema.NonEmptyString,
      connected: Schema.Boolean,
      lastSeenAt: Schema.optionalKey(Schema.Finite),
    }),
  ),
  extensionDirectory: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
})
export type ChromeStatusProjection = typeof ChromeStatusProjection.Type
