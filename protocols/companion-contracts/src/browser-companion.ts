import { Schema } from "effect";

export const BROWSER_COMPANION_CONTRACT = "pipee/browser-companion@2" as const;

export const BrowserCompanionManifest = Schema.Struct({
  contract: Schema.Literal(BROWSER_COMPANION_CONTRACT),
  directory: Schema.String,
  evidence: Schema.String,
});
export type BrowserCompanionManifest = typeof BrowserCompanionManifest.Type;

export const BrowserCompanionExpectation = Schema.Struct({
  extensionId: Schema.NonEmptyString,
  displayVersion: Schema.NonEmptyString,
  protocolFingerprint: Schema.NonEmptyString,
});
export type BrowserCompanionExpectation = typeof BrowserCompanionExpectation.Type;

export const BROWSER_COMPANION_PROBE_KIND = "pipee/browser-companion-probe" as const;
export const BrowserCompanionProbeRequest = Schema.Struct({
  kind: Schema.Literal(BROWSER_COMPANION_PROBE_KIND),
  version: Schema.Literal(2),
});
export type BrowserCompanionProbeRequest = typeof BrowserCompanionProbeRequest.Type;
export const browserCompanionProbeRequest: BrowserCompanionProbeRequest = {
  kind: BROWSER_COMPANION_PROBE_KIND,
  version: 2,
};
export const BrowserCompanionProbeResponse = Schema.Struct({
  kind: Schema.Literal(BROWSER_COMPANION_PROBE_KIND),
  version: Schema.Literal(2),
  extension: BrowserCompanionExpectation,
});
export type BrowserCompanionProbeResponse = typeof BrowserCompanionProbeResponse.Type;
export const isBrowserCompanionProbeRequest = Schema.is(BrowserCompanionProbeRequest);

export const BrowserCompanionMismatch = Schema.Literals([
  "ExtensionId",
  "DisplayVersion",
  "ProtocolFingerprint",
]);
export type BrowserCompanionMismatch = typeof BrowserCompanionMismatch.Type;

export const browserCompanionMismatches = (
  expected: BrowserCompanionExpectation,
  actual: BrowserCompanionExpectation,
): ReadonlyArray<BrowserCompanionMismatch> => {
  const mismatches: Array<BrowserCompanionMismatch> = [];
  if (expected.extensionId !== actual.extensionId) mismatches.push("ExtensionId");
  if (expected.displayVersion !== actual.displayVersion) mismatches.push("DisplayVersion");
  if (expected.protocolFingerprint !== actual.protocolFingerprint)
    mismatches.push("ProtocolFingerprint");
  return mismatches;
};

export const BrowserCompanionProbe = Schema.Union([
  Schema.TaggedStruct("Missing", { expected: BrowserCompanionExpectation }),
  Schema.TaggedStruct("Compatible", {
    expected: BrowserCompanionExpectation,
    actual: BrowserCompanionExpectation,
  }),
  Schema.TaggedStruct("Incompatible", {
    expected: BrowserCompanionExpectation,
    actual: BrowserCompanionExpectation,
    mismatches: Schema.Array(BrowserCompanionMismatch),
  }),
]);
export type BrowserCompanionProbe = typeof BrowserCompanionProbe.Type;

export const BROWSER_COMPANION_WAKE_KIND = "pipee/browser-companion-wake" as const;
export const BrowserCompanionWakeRequest = Schema.Struct({
  kind: Schema.Literal(BROWSER_COMPANION_WAKE_KIND),
  version: Schema.Literal(2),
});
export type BrowserCompanionWakeRequest = typeof BrowserCompanionWakeRequest.Type;
export const browserCompanionWakeRequest: BrowserCompanionWakeRequest = {
  kind: BROWSER_COMPANION_WAKE_KIND,
  version: 2,
};

export const BrowserCompanionWakeResponse = Schema.Struct({
  kind: Schema.Literal(BROWSER_COMPANION_WAKE_KIND),
  version: Schema.Literal(2),
  accepted: Schema.Boolean,
});
export type BrowserCompanionWakeResponse = typeof BrowserCompanionWakeResponse.Type;
export const isBrowserCompanionWakeRequest = Schema.is(BrowserCompanionWakeRequest);
