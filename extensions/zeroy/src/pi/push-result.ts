import type { JsonRecord } from "../domain/protocol.js";

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const asString = (value: unknown, limit = 512): string | null =>
  typeof value === "string" ? value.slice(0, limit) : null;

const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * The REST receipt is an audit object owned by WordPress. A push result is a
 * command outcome owned by the agent boundary: constant-size identity and
 * state only. Review actions and build diagnostics remain queryable from the
 * materialized checkout / zeroy_inspect, never echoed after every mutation.
 */
export const pushAgentProjection = (value: unknown): JsonRecord => {
  const receipt = asRecord(value) ?? {};
  const build = asRecord(receipt.build);
  const preview = asRecord(receipt.preview);
  const proof = asRecord(receipt.proof);
  const review = asRecord(receipt.review);
  const browser = asRecord(receipt.browser);
  const preflight = asRecord(receipt.preflight);

  return {
    contract: "zeroy/push-result@1",
    commit: asString(receipt.commit, 128),
    draftRef: asString(receipt.draftRef, 256),
    build:
      build === null
        ? null
        : {
            buildId: asString(build.buildId, 128),
            state: asString(build.state, 64),
            failureCount: asCount(build.failureCount),
            diagnosticCount: asCount(build.diagnosticCount),
          },
    preview:
      preview === null
        ? null
        : {
            releaseId: asString(preview.releaseId, 128),
            url: asString(preview.url, 2048),
            state: asString(preview.state, 64),
          },
    proof:
      proof === null
        ? null
        : {
            proofId: asString(proof.proofId, 128),
            state: asString(proof.state, 64),
            failureCount: asCount(proof.failureCount),
          },
    review:
      review === null
        ? null
        : {
            state: asString(review.state, 64),
            remainingCount: asCount(review.remainingCount),
            releaseId: asString(review.releaseId, 128),
            proofId: asString(review.proofId, 128),
          },
    browser:
      browser === null
        ? null
        : {
            state: asString(browser.state, 64),
            code: asString(browser.code, 128),
            message: asString(browser.message),
          },
    preflight:
      preflight === null
        ? null
        : {
            state: asString(preflight.state, 64),
            code: asString(preflight.code, 128),
            message: asString(preflight.message),
          },
  };
};
