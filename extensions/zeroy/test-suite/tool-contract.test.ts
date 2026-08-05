import { describe, expect, it } from "vite-plus/test";
import { Value } from "@sinclair/typebox/value";
import {
  CheckoutInputContract,
  CheckoutProviderProjection,
  InspectProviderProjection,
  PushInputContract,
  PushProviderProjection,
  SiteReleaseReceiptContract,
  decodeCheckoutInput,
  decodeInspectInput,
  decodePushInput,
  validateProviderSchemaDocument,
} from "../src/domain/protocol.js";
import { agentResultBoundary } from "../src/pi/tool-result.js";

const siteId = "site-a";

describe("zeroY SiteCheckout tool contracts", () => {
  it("exposes bounded commit-oriented inspection views", () => {
    const valid = [
      { resource: "sites" },
      { siteId, resource: "refs", limit: 20 },
      { siteId, resource: "commit", commit: `sha256:${"a".repeat(64)}` },
      { siteId, resource: "releaseHistory" },
      { siteId, resource: "site" },
      { siteId, resource: "current" },
      { siteId, resource: "review" },
      { siteId, resource: "review", reviewView: "actions", limit: 20, cursor: "next" },
      { siteId, resource: "proof", proofId: "proof-1" },
      {
        siteId,
        resource: "proof",
        proofId: "proof-1",
        proofView: "repairGroups",
        limit: 20,
        cursor: "next",
      },
      {
        siteId,
        resource: "proof",
        proofId: "proof-1",
        proofView: "failureInstances",
      },
      { siteId, resource: "integrity" },
      { siteId, resource: "externalCheck" },
      {
        siteId,
        resource: "externalCheck",
        externalCheckView: "pages",
        limit: 10,
        cursor: "10",
      },
    ];
    for (const input of valid) expect(decodeInspectInput(input)._tag).toBe("Success");
    for (const resource of [
      "draft",
      "drafts",
      "themeFiles",
      "content",
      "schema",
      "inventory",
      "acf",
      "zcssContract",
    ]) {
      expect(decodeInspectInput({ siteId, resource })._tag).toBe("Failure");
    }
    expect(
      decodeInspectInput({ siteId, resource: "proof", proofId: "proof-1", proofView: "failures" })
        ._tag,
    ).toBe("Failure");
  });

  it("keeps checkout and push free of transport mechanics and file bytes", () => {
    const checkout = { siteId, source: "active-release" } as const;
    const draftCheckout = {
      siteId,
      source: "draft-ref",
      draftRef: "refs/drafts/example",
    } as const;
    const push = { siteId, checkoutId: "checkout-1", message: "ship" } as const;
    expect(Value.Check(CheckoutInputContract, checkout)).toBe(true);
    expect(Value.Check(PushInputContract, push)).toBe(true);
    expect(decodeCheckoutInput(checkout)).toEqual({ _tag: "Success", value: checkout });
    expect(decodeCheckoutInput(draftCheckout)).toEqual({
      _tag: "Success",
      value: draftCheckout,
    });
    expect(decodeCheckoutInput({ siteId, source: { draftRef: "refs/drafts/example" } })._tag).toBe(
      "Failure",
    );
    expect(decodePushInput(push)).toEqual({ _tag: "Success", value: push });
    for (const forbidden of [
      "content",
      "blobRef",
      "commandId",
      "headHash",
      "expectedRevision",
      "expectedBaseReleaseId",
      "mode",
    ]) {
      expect(decodePushInput({ ...push, [forbidden]: "forbidden" })._tag).toBe("Failure");
    }
  });

  it("fails closed before internal compiler state or unbounded receipts enter context", () => {
    expect(agentResultBoundary({ build: { buildId: `sha256:${"a".repeat(64)}` } }).ok).toBe(true);
    for (const key of ["fieldId", "sourceHash", "revision", "overlay", "bytesBase64"]) {
      expect(agentResultBoundary({ nested: { [key]: "private" } }).ok).toBe(false);
    }
    expect(agentResultBoundary({ payload: "x".repeat(17 * 1024) }).ok).toBe(false);
  });

  it("projects all three provider documents as provider-safe open objects while decoders stay exact", () => {
    for (const projection of [
      InspectProviderProjection,
      CheckoutProviderProjection,
      PushProviderProjection,
    ]) {
      expect(projection._tag).toBe("Success");
      if (projection._tag === "Failure") continue;
      expect(validateProviderSchemaDocument(projection.value)._tag).toBe("Success");
      expect(projection.value.type).toBe("object");
      expect(JSON.stringify(projection.value)).not.toMatch(/"\$ref"/);
      expect(JSON.stringify(projection.value)).not.toMatch(/"additionalProperties"/);
    }
    if (InspectProviderProjection._tag === "Success") {
      expect(InspectProviderProjection.value.properties.resource.enum).toEqual([
        "sites",
        "refs",
        "commit",
        "releaseHistory",
        "site",
        "current",
        "review",
        "proof",
        "integrity",
        "externalCheck",
      ]);
    }
  });

  it("types the compact commit-bound SiteRelease projection", () => {
    const release = {
      contract: "zeroy/site-release@3",
      releaseId: "release-1",
      commit: `sha256:${"a".repeat(64)}`,
      buildId: `sha256:${"0".repeat(64)}`,
      previousReleaseId: null,
      themeArtifactId: `sha256:${"b".repeat(64)}`,
      siteLogicArtifactId: `sha256:${"c".repeat(64)}`,
      themeContractHash: "d".repeat(64),
      zcss: null,
      siteLogicContractHash: "e".repeat(64),
      storageEpoch: 0,
      snapshotHash: "f".repeat(64),
      expectedActiveReleaseId: null,
      reviewBriefHash: null,
      state: "active",
      proofId: "proof-1",
      activeReleaseId: "release-1",
      provenance: { source: "site-checkout" },
      diagnostics: { contract: "zeroy/site-release-diagnostics@1", migration: null, proof: null },
      browserVerification: null,
      createdAt: "2026-08-03 00:00:00",
      activatedAt: "2026-08-03 00:00:01",
      previewUrl: null,
    };
    expect(Value.Check(SiteReleaseReceiptContract, release)).toBe(true);
    expect(Value.Check(SiteReleaseReceiptContract, { ...release, commit: null })).toBe(true);
  });
});
