import { describe, expect, it } from "vite-plus/test";
import { Value } from "@sinclair/typebox/value";
import {
  ContentOperationContract,
  ContentStageInputContract,
  ContentStageProviderProjection,
  ContentInspectionProviderProjection,
  InspectProviderProjection,
  SiteCommitProviderProjection,
  SiteDraftInspectionContract,
  SiteDraftReceiptContract,
  SiteCommitInputContract,
  SiteReleaseReceiptContract,
  ThemeStageInputContract,
  ThemeStageProviderProjection,
  decodeContentStageInput,
  decodeInspectInput,
  decodeSiteCommitInput,
  decodeThemeStageInput,
} from "../src/domain/protocol.js";

const siteId = "site-a";

describe("zeroY remote stage contracts", () => {
  it("keeps stable remote success envelopes typed without copying site facts locally", () => {
    const draft = {
      contract: "zeroy/site-draft@1",
      draftId: "draft-1",
      baseReleaseId: null,
      state: "open",
      operationCount: 1,
      operationsHash: "a".repeat(64),
      lastOperation: {
        operationId: "operation-1",
        kind: "writeTranslationDraft",
        nextRevision: 1,
      },
      proofId: null,
      replayedFromDraftId: null,
      diagnostics: {},
      operationSummaries: [],
      stagedRefs: {},
      affectedSubjects: [],
      affectedArtifacts: [],
      lastArtifactFiles: [
        { artifact: "theme", path: "style.css", state: "written", hash: "b".repeat(64) },
      ],
      createdAt: "2026-08-02 00:00:00",
      updatedAt: "2026-08-02 00:00:00",
    };
    const inspection = {
      contract: "zeroy/site-draft-inspection@1",
      draft,
      candidate: {
        contract: "zeroy/site-draft-candidate@1",
        state: "unavailable",
        reason: "draft-not-open",
      },
    };
    const release = {
      contract: "zeroy/site-release@1",
      releaseId: "release-1",
      draftId: "draft-1",
      themeArtifactId: "sha256:" + "c".repeat(64),
      siteLogicArtifactId: "sha256:" + "d".repeat(64),
      themeContractHash: "e".repeat(64),
      siteLogicContractHash: "f".repeat(64),
      storageEpoch: 0,
      snapshotHash: "a".repeat(64),
      expectedActiveReleaseId: null,
      state: "active",
      proofId: "proof-1",
      activeReleaseId: "release-1",
      provenance: { source: "site-draft" },
      diagnostics: {
        contract: "zeroy/site-release-diagnostics@1",
        migration: null,
        proof: { blockingFailures: [] },
      },
      affectedSubjects: [],
      affectedArtifacts: [],
      createdAt: "2026-08-02 00:00:00",
      activatedAt: "2026-08-02 00:00:01",
      previewUrl: null,
    };
    expect(Value.Check(SiteDraftReceiptContract, draft)).toBe(true);
    expect(Value.Check(SiteDraftInspectionContract, inspection)).toBe(true);
    expect(Value.Check(SiteReleaseReceiptContract, release)).toBe(true);
    expect(Value.Check(SiteReleaseReceiptContract, { ...release, state: "superseded" })).toBe(true);
    expect(
      Value.Check(SiteReleaseReceiptContract, { ...release, diagnostics: { contract: "wrong" } }),
    ).toBe(false);
  });

  it("accepts the remote inspect resources and rejects retired ones", () => {
    const valid = [
      { resource: "sites" },
      { siteId, resource: "site" },
      { siteId, resource: "schema" },
      { siteId, resource: "inventory" },
      { siteId, resource: "acf" },
      { siteId, resource: "release" },
      { siteId, resource: "draft", draftId: "draft-1" },
      { siteId, resource: "proof", proofId: "proof-1" },
      { siteId, resource: "themeFiles", path: "functions.php" },
      { siteId, resource: "content", content: { kind: "canonical", objectId: 1 } },
      {
        siteId,
        resource: "content",
        content: { kind: "adoption-candidates", postType: "page" },
      },
      {
        siteId,
        resource: "content",
        content: {
          kind: "existing-post",
          postId: 1,
          schemaId: "showcase",
          draftId: "draft-1",
        },
      },
      {
        siteId,
        resource: "content",
        content: { kind: "translation", subject: { kind: "post", id: 1 }, locale: "zh" },
      },
      { siteId, resource: "integrity" },
      { siteId, resource: "externalCheck" },
    ];
    for (const input of valid) expect(decodeInspectInput(input)._tag).toBe("Success");
    expect(decodeInspectInput({ siteId, resource: "contentTree" })._tag).toBe("Failure");
  });

  it("keeps stage and commit top-level schemas provider-safe", () => {
    expect(
      Value.Check(ThemeStageInputContract, {
        siteId,
        files: [{ path: "x.php", content: "<?php", expectedHash: null }],
      }),
    ).toBe(true);
    expect(
      Value.Check(ThemeStageInputContract, {
        siteId,
        files: [{ path: "obsolete.php", content: null, expectedHash: "a".repeat(64) }],
      }),
    ).toBe(true);
    expect(
      Value.Check(ThemeStageInputContract, {
        siteId,
        files: [{ path: "obsolete.php", content: null, expectedHash: null }],
      }),
    ).toBe(false);
    expect(
      Value.Check(ContentStageInputContract, {
        siteId,
        operation: {
          kind: "createCanonical",
          ref: "home",
          postType: "page",
          schemaId: "home",
          route: "/",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(SiteCommitInputContract, {
        siteId,
        draftId: "draft-1",
        expectedBaseReleaseId: "release-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SiteCommitInputContract, {
        siteId,
        draftId: "draft-1",
        expectedBaseReleaseId: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(ContentOperationContract, {
        kind: "replayDraft",
        sourceDraftId: "draft-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(ContentOperationContract, {
        kind: "publishTranslation",
        subject: { kind: "post", id: 1 },
        locale: "en",
        expectedRevision: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(ContentOperationContract, {
        kind: "retireCanonical",
        objectId: 1,
        expectedRevision: 2,
      }),
    ).toBe(true);
    for (const kind of ["menu", "media"] as const)
      expect(
        Value.Check(ContentOperationContract, {
          kind: "publishTranslation",
          subject: { kind, id: 1 },
          locale: "en",
          expectedRevision: 1,
        }),
      ).toBe(false);
    expect(
      Value.Check(ContentOperationContract, {
        kind: "writeCanonicalContent",
        objectRef: 1,
        expectedRevision: 0,
        postTitle: "Updated title",
        acf: { capacity: "10 t/h" },
      }),
    ).toBe(true);
    expect(Value.Check(ContentOperationContract, { kind: "unknown" })).toBe(false);
    expect(InspectProviderProjection._tag).toBe("Success");
    expect(ThemeStageProviderProjection._tag).toBe("Success");
    expect(SiteCommitProviderProjection._tag).toBe("Success");
  });

  it("decodes every staged mutation before it can cross the Connector boundary", () => {
    expect(
      decodeThemeStageInput({
        siteId,
        files: [{ path: "obsolete.php", content: null, expectedHash: null }],
      })._tag,
    ).toBe("Failure");
    expect(
      decodeContentStageInput({
        siteId,
        operation: { kind: "createCanonical", ref: "home", postType: "page", schemaId: "home" },
      })._tag,
    ).toBe("Failure");
    expect(
      decodeContentStageInput({
        siteId,
        operation: { kind: "replayDraft" },
      }),
    ).toMatchObject({
      _tag: "Failure",
      error: { message: "kind replayDraft requires fields: sourceDraftId." },
    });
    expect(
      decodeContentStageInput({
        siteId,
        draftId: "draft-1",
        operation: { kind: "replayDraft", sourceDraftId: "stale-draft" },
      }),
    ).toMatchObject({
      _tag: "Failure",
      error: {
        message:
          "kind replayDraft must omit draftId because replay creates and returns a new open SiteDraft.",
      },
    });
    expect(decodeSiteCommitInput({ siteId, draftId: "draft-1" })._tag).toBe("Failure");
  });

  it("projects nested discriminators without weakening execution validation", () => {
    expect(ContentInspectionProviderProjection._tag).toBe("Success");
    expect(ContentStageProviderProjection._tag).toBe("Success");
    if (
      ContentInspectionProviderProjection._tag === "Failure" ||
      ContentStageProviderProjection._tag === "Failure"
    )
      return;

    const inspection = ContentInspectionProviderProjection.value as unknown as {
      properties: { kind: { enum: readonly string[] }; objectId: { description?: string } };
      required: readonly string[];
    };
    expect(inspection.properties.kind.enum).toEqual([
      "canonical",
      "adoption-candidates",
      "existing-post",
      "translation",
    ]);
    expect(inspection.required).toEqual(["kind"]);
    expect(inspection.properties.objectId.description).toContain("Required when kind = canonical");

    const content = ContentStageProviderProjection.value as unknown as {
      properties: {
        operation: {
          properties: { kind: { enum: readonly string[] }; ref: { description?: string } };
          required: readonly string[];
        };
      };
    };
    expect(content.properties.operation.properties.kind.enum).toEqual([
      "replayDraft",
      "siteConfig",
      "createCanonical",
      "adoptCanonical",
      "retireCanonical",
      "assignSchema",
      "writeTemplateContent",
      "writeCanonicalContent",
      "writeTranslationDraft",
      "publishTranslation",
      "unpublishTranslation",
    ]);
    expect(content.properties.operation.required).toEqual(["kind"]);
    expect(content.properties.operation.properties.ref.description).toContain(
      "Required when kind = createCanonical",
    );
    expect(
      decodeContentStageInput({
        siteId,
        operation: { kind: "createCanonical", ref: "home", postType: "page", schemaId: "home" },
      }),
    ).toMatchObject({
      _tag: "Failure",
      error: { message: "kind createCanonical requires fields: route." },
    });
    expect(
      decodeContentStageInput({
        siteId,
        operation: { kind: "retireCanonical", objectId: 1, expectedRevision: 0 },
      }),
    ).toMatchObject({
      _tag: "Failure",
      error: { message: "kind retireCanonical requires expectedRevision to be at least 1." },
    });
    expect(
      decodeInspectInput({ siteId, resource: "content", content: { kind: "canonical" } }),
    ).toMatchObject({
      _tag: "Failure",
      error: { message: "kind canonical requires fields: objectId." },
    });
  });

  it("projects provider-safe branch extras back to the exact execution branch", () => {
    expect(
      decodeInspectInput({
        resource: "sites",
        siteId: "provider-default",
        page: 1,
        perPage: 100,
        draftId: "unused",
        proofId: "unused",
        path: "unused",
        content: {
          kind: "canonical",
          objectId: 1,
          postType: "page",
          schemaId: "unused",
          page: 1,
          perPage: 1,
          postId: 1,
          subject: { kind: "site-copy", id: "default" },
          locale: "en",
          draftId: "unused",
        },
        urls: [],
      }),
    ).toEqual({ _tag: "Success", value: { resource: "sites" } });
    expect(
      decodeContentStageInput({
        siteId,
        operation: {
          kind: "createCanonical",
          ref: "home",
          postType: "page",
          schemaId: "home",
          route: "/",
          sourceDraftId: "unused",
          expectedRevision: 0,
        },
      }),
    ).toEqual({
      _tag: "Success",
      value: {
        siteId,
        operation: {
          kind: "createCanonical",
          ref: "home",
          postType: "page",
          schemaId: "home",
          route: "/",
        },
      },
    });
    expect(decodeInspectInput({ resource: "sites", unlisted: true })).toMatchObject({
      _tag: "Failure",
      error: { message: "resource sites has unknown fields: unlisted." },
    });
  });
});
