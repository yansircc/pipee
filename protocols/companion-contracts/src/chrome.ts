import { Schema } from "effect";
import {
  BrowserCompanionExpectation,
  BrowserCompanionMismatch,
  BROWSER_COMPANION_PROBE_KIND,
  BrowserCompanionProbeRequest,
  BrowserCompanionProbeResponse,
  browserCompanionProbeRequest,
  browserCompanionMismatches,
  type BrowserCompanionProbe,
} from "@pi-suite/companion-contracts/browser-companion";

export const ChromeExtensionExpectation = BrowserCompanionExpectation;
export type ChromeExtensionExpectation = typeof ChromeExtensionExpectation.Type;

export const CHROME_EXTENSION_PROBE_KIND = BROWSER_COMPANION_PROBE_KIND;
export const ChromeExtensionProbeRequest = BrowserCompanionProbeRequest;
export type ChromeExtensionProbeRequest = typeof ChromeExtensionProbeRequest.Type;

export const chromeExtensionProbeRequest: ChromeExtensionProbeRequest =
  browserCompanionProbeRequest;

export const isChromeExtensionProbeRequest = Schema.is(ChromeExtensionProbeRequest);

export const ChromeExtensionProbeResponse = BrowserCompanionProbeResponse;
export type ChromeExtensionProbeResponse = typeof ChromeExtensionProbeResponse.Type;

export const ChromeExtensionEvidence = Schema.Struct({
  ...ChromeExtensionExpectation.fields,
  connectorIdentity: Schema.Struct({
    connectorId: Schema.NonEmptyString,
    connectorLabel: Schema.NonEmptyString,
  }),
});
export type ChromeExtensionEvidence = typeof ChromeExtensionEvidence.Type;

export interface ChromeConnectorEvidenceSource {
  readonly connectorId: string;
  readonly label: string;
  readonly extensionId: string;
  readonly extensionDisplayVersion: string;
  readonly protocolFingerprint: string;
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
});

export const ChromeCompatibilityMismatch = BrowserCompanionMismatch;

export const chromeExtensionMismatches = (
  expected: ChromeExtensionExpectation,
  actual: ChromeExtensionExpectation,
): ReadonlyArray<typeof ChromeCompatibilityMismatch.Type> => {
  return browserCompanionMismatches(expected, actual);
};

export const ChromeCompatibility = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Verified", { evidence: ChromeExtensionEvidence }),
  Schema.TaggedStruct("Incompatible", {
    expected: ChromeExtensionExpectation,
    actual: ChromeExtensionEvidence,
    mismatches: Schema.Array(ChromeCompatibilityMismatch),
  }),
]);
export type ChromeCompatibility = typeof ChromeCompatibility.Type;
export type ChromeKnownCompatibility = Exclude<ChromeCompatibility, { readonly _tag: "Unknown" }>;

export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation,
  actual: ChromeExtensionEvidence,
): ChromeKnownCompatibility;
export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation | null,
  actual: ChromeExtensionEvidence | null,
): ChromeCompatibility;
export function classifyChromeCompatibility(
  expected: ChromeExtensionExpectation | null,
  actual: ChromeExtensionEvidence | null,
): ChromeCompatibility {
  if (expected === null || actual === null) return { _tag: "Unknown" };
  const mismatches = chromeExtensionMismatches(expected, actual);
  return mismatches.length === 0
    ? { _tag: "Verified", evidence: actual }
    : { _tag: "Incompatible", expected, actual, mismatches };
}

export const classifyChromeConnectorCompatibility = (
  expected: ChromeExtensionExpectation,
  connector: ChromeConnectorEvidenceSource,
): ChromeKnownCompatibility =>
  classifyChromeCompatibility(expected, projectChromeExtensionEvidence(connector));

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
});
export type ChromeStatusProjection = typeof ChromeStatusProjection.Type;

export const CompanionReadiness = Schema.Union([
  Schema.TaggedStruct("PackageMissing", {}),
  Schema.TaggedStruct("CompanionMissing", { expected: ChromeExtensionExpectation }),
  Schema.TaggedStruct("CompanionIncompatible", {
    expected: ChromeExtensionExpectation,
    actual: ChromeExtensionExpectation,
    mismatches: Schema.Array(ChromeCompatibilityMismatch),
  }),
  Schema.TaggedStruct("Connecting", {
    expected: ChromeExtensionExpectation,
    startedAt: Schema.Finite,
  }),
  Schema.TaggedStruct("Ready", {
    expected: ChromeExtensionExpectation,
    connector: Schema.Struct({
      id: Schema.NonEmptyString,
      label: Schema.NonEmptyString,
      lastSeenAt: Schema.optionalKey(Schema.Finite),
    }),
  }),
  Schema.TaggedStruct("ConnectionFailed", {
    expected: ChromeExtensionExpectation,
    reason: Schema.Literals([
      "bridge-unavailable",
      "connector-timeout",
      "profile-offline",
      "protocol-mismatch",
    ]),
    message: Schema.String,
  }),
]);
export type CompanionReadiness = typeof CompanionReadiness.Type;

export const projectCompanionReadiness = (input: {
  readonly expected: ChromeExtensionExpectation | null;
  readonly probe: BrowserCompanionProbe | null;
  readonly status: ChromeStatusProjection | null;
  readonly startedAt: number;
  readonly now: number;
  readonly timeoutMs?: number;
}): CompanionReadiness => {
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (input.expected === null) return { _tag: "PackageMissing" };
  if (input.probe === null || input.probe._tag === "Missing") {
    return { _tag: "CompanionMissing", expected: input.expected };
  }
  if (input.probe._tag === "Incompatible") {
    return {
      _tag: "CompanionIncompatible",
      expected: input.probe.expected,
      actual: input.probe.actual,
      mismatches: input.probe.mismatches,
    };
  }
  const status = input.status;
  if (
    status?.state === "ready" &&
    status.bridge === "running" &&
    status.connector?.connected === true
  ) {
    return {
      _tag: "Ready",
      expected: input.expected,
      connector: {
        id: status.connector.id,
        label: status.connector.label,
        ...(status.connector.lastSeenAt === undefined
          ? {}
          : { lastSeenAt: status.connector.lastSeenAt }),
      },
    };
  }
  if (status?.state === "error") {
    return {
      _tag: "ConnectionFailed",
      expected: input.expected,
      reason: status.errorMessage?.includes("incompatible")
        ? "protocol-mismatch"
        : "bridge-unavailable",
      message: status.errorMessage ?? "Chrome bridge is unavailable",
    };
  }
  if (input.now - input.startedAt >= timeoutMs) {
    return {
      _tag: "ConnectionFailed",
      expected: input.expected,
      reason: status?.state === "offline" ? "profile-offline" : "connector-timeout",
      message:
        status?.state === "offline"
          ? "Chrome profile did not reconnect before the deadline"
          : "Chrome Companion did not connect before the deadline",
    };
  }
  return { _tag: "Connecting", expected: input.expected, startedAt: input.startedAt };
};
