import { describe, expect, it } from "vite-plus/test";
import { pushAgentProjection } from "../src/pi/push-result.js";
import { agentResultBoundary } from "../src/pi/tool-result.js";

describe("zeroY push agent projection", () => {
  it("returns only the constant-size command outcome", () => {
    const result = pushAgentProjection({
      contract: "zeroy/push-receipt@3",
      commit: `sha256:${"a".repeat(64)}`,
      draftRef: "refs/drafts/connector/session",
      build: {
        buildId: `sha256:${"b".repeat(64)}`,
        state: "renderable",
        failureCount: 0,
        diagnosticCount: 19,
        diagnostics: { operationSummaries: Array.from({ length: 100 }, () => ({ revision: 1 })) },
      },
      preview: {
        releaseId: "preview-1",
        url: "https://example.test/__zeroy-preview/preview-1/",
        state: "preview",
        browserVerification: { bytesBase64: "secret" },
      },
      proof: { proofId: "proof-1", state: "blocked", failureCount: 41 },
      review: {
        state: "revise",
        remainingCount: 41,
        next: [{ fieldId: "/acf/field_capacity", sourceHash: "internal", repair: "Do work" }],
      },
      browser: { state: "deferred", code: "zeroy_browser_evidence_invalid", message: "retry" },
      internal: { fileContent: "never expose" },
    });

    expect(result).toEqual({
      contract: "zeroy/push-result@1",
      commit: `sha256:${"a".repeat(64)}`,
      draftRef: "refs/drafts/connector/session",
      build: {
        buildId: `sha256:${"b".repeat(64)}`,
        state: "renderable",
        failureCount: 0,
        diagnosticCount: 19,
      },
      preview: {
        releaseId: "preview-1",
        url: "https://example.test/__zeroy-preview/preview-1/",
        state: "preview",
      },
      proof: { proofId: "proof-1", state: "blocked", failureCount: 41 },
      review: { state: "revise", remainingCount: 41, releaseId: null, proofId: null },
      browser: { state: "deferred", code: "zeroy_browser_evidence_invalid", message: "retry" },
      preflight: null,
    });
    expect(agentResultBoundary(result).ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("operationSummaries");
    expect(JSON.stringify(result)).not.toContain("browserVerification");
    expect(JSON.stringify(result)).not.toContain("fileContent");
    expect(JSON.stringify(result)).not.toContain("field_capacity");
  });
});
