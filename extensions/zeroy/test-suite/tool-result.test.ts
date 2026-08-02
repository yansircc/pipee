import { describe, expect, it } from "vite-plus/test";
import { ZeroYConnectorError } from "../src/domain/client.js";
import { toolFailurePayload } from "../src/pi/tool-result.js";

describe("zeroY Pi tool failure projection", () => {
  it("preserves the complete Connector recovery envelope", () => {
    const blockingFailure = {
      code: "theme_runtime_side_effect_forbidden",
      invariant: "ThemeArtifact is read-only.",
      repair: "Remove the request-time write.",
    };
    expect(
      toolFailurePayload(
        new ZeroYConnectorError({
          message: "CandidateProof blocked SiteDraft commit.",
          status: 409,
          code: "zeroy_site_commit_proof_failed",
          data: {
            draftId: "draft-1",
            releaseId: "release-2",
            proofId: "proof-2",
            diagnostics: { proof: { blockingFailures: [blockingFailure] } },
            affectedSubjects: [{ kind: "post", id: 42 }],
            affectedArtifacts: [{ kind: "theme", id: "theme-2" }],
          },
        }),
      ),
    ).toEqual({
      error: {
        code: "zeroy_site_commit_proof_failed",
        message: "CandidateProof blocked SiteDraft commit.",
        status: 409,
        data: {
          draftId: "draft-1",
          releaseId: "release-2",
          proofId: "proof-2",
          diagnostics: { proof: { blockingFailures: [blockingFailure] } },
          affectedSubjects: [{ kind: "post", id: 42 }],
          affectedArtifacts: [{ kind: "theme", id: "theme-2" }],
        },
      },
    });
  });
});
