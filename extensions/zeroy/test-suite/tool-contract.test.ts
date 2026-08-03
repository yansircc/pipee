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

const siteId = "site-a";

describe("zeroY SiteCheckout tool contracts", () => {
  it("exposes bounded commit-oriented inspection views", () => {
    const valid = [
      { resource: "sites" },
      { siteId, resource: "refs", limit: 20 },
      { siteId, resource: "commit", commit: `sha256:${"a".repeat(64)}` },
      { siteId, resource: "releaseHistory" },
      { siteId, resource: "site" },
      { siteId, resource: "schema" },
      { siteId, resource: "inventory" },
      { siteId, resource: "acf" },
      { siteId, resource: "zcssContract" },
      { siteId, resource: "proof", proofId: "proof-1", proofView: "repairGroups" },
      { siteId, resource: "integrity" },
      { siteId, resource: "externalCheck" },
    ];
    for (const input of valid) expect(decodeInspectInput(input)._tag).toBe("Success");
    for (const resource of ["draft", "drafts", "themeFiles", "content"]) {
      expect(decodeInspectInput({ siteId, resource })._tag).toBe("Failure");
    }
  });

  it("keeps checkout and push free of transport mechanics and file bytes", () => {
    const checkout = { siteId, source: "active-release" } as const;
    const push = { siteId, checkoutId: "checkout-1", mode: "release", message: "ship" } as const;
    expect(Value.Check(CheckoutInputContract, checkout)).toBe(true);
    expect(Value.Check(PushInputContract, push)).toBe(true);
    expect(decodeCheckoutInput(checkout)).toEqual({ _tag: "Success", value: checkout });
    expect(decodePushInput(push)).toEqual({ _tag: "Success", value: push });
    for (const forbidden of [
      "content",
      "blobRef",
      "commandId",
      "headHash",
      "expectedRevision",
      "expectedBaseReleaseId",
    ]) {
      expect(decodePushInput({ ...push, [forbidden]: "forbidden" })._tag).toBe("Failure");
    }
  });

  it("projects all three provider documents as closed top-level objects", () => {
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
    }
    if (InspectProviderProjection._tag === "Success") {
      expect(InspectProviderProjection.value.properties.resource.enum).toEqual([
        "sites",
        "refs",
        "commit",
        "releaseHistory",
        "site",
        "schema",
        "inventory",
        "acf",
        "zcssContract",
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
      previousReleaseId: null,
      themeArtifactId: `sha256:${"b".repeat(64)}`,
      siteLogicArtifactId: `sha256:${"c".repeat(64)}`,
      themeContractHash: "d".repeat(64),
      zcss: null,
      siteLogicContractHash: "e".repeat(64),
      storageEpoch: 0,
      snapshotHash: "f".repeat(64),
      expectedActiveReleaseId: null,
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
