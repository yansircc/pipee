import { describe, expect, it } from "vite-plus/test";
import { Value } from "@sinclair/typebox/value";
import {
  ContentInputContract,
  ContentProviderProjection,
  InspectInputContract,
  InspectProviderProjection,
  decodeContentInput,
  decodeInspectInput,
} from "../src/domain/protocol.js";

const siteId = "site-a";
const profile = {
  contract: "zeroy/translation-profile@1" as const,
  companySummary: "Industrial equipment maker",
  targetAudience: "B2B buyers",
  brandVoice: "clear",
  localeGuidance: { en: "Use technical English." },
  glossary: [],
  protectedTerms: [],
};

describe("zeroY tool contracts", () => {
  it("accepts exactly the supported inspection resources", () => {
    const valid = [
      { resource: "sites" },
      { siteId, resource: "site" },
      { siteId, resource: "schema" },
      { siteId, resource: "inventory" },
      { siteId, resource: "acf" },
      { siteId, resource: "canonicalContent", objectId: 1 },
      { siteId, resource: "adoptionCandidates" },
      { siteId, resource: "existingPost", postId: 1 },
      { siteId, resource: "themeState" },
      { siteId, resource: "themeArtifact", artifactId: `sha256:${"a".repeat(64)}` },
      { siteId, resource: "translationJob", subject: { kind: "post", id: 1 }, locale: "en" },
      { siteId, resource: "integrity" },
      { siteId, resource: "externalCheck" },
      { siteId, resource: "externalCheck", urls: ["https://site.test/preview"] },
    ];
    for (const input of valid) expect(decodeInspectInput(input)._tag).toBe("Success");
    expect(decodeInspectInput({ siteId, resource: "contentTree" })._tag).toBe("Failure");
    expect(decodeInspectInput({ siteId, resource: "externalCheck", urls: [""] })._tag).toBe(
      "Failure",
    );
  });

  it("accepts only canonical, TemplateContent, and Overlay mutations", () => {
    const valid = [
      {
        siteId,
        action: "siteConfig",
        siteConfig: {
          defaultLocale: "zh-CN",
          enabledLocales: [
            { locale: "zh-CN", label: "中文", urlPrefix: "" },
            { locale: "en", label: "English", urlPrefix: "en" },
          ],
          translationProfile: profile,
          siteCopy: {},
        },
        expectedRevision: 1,
      },
      { siteId, action: "createCanonical", postType: "page", schemaId: "home", postTitle: "Home" },
      {
        siteId,
        action: "adoptCanonical",
        postId: 2,
        schemaId: "machine",
        expectedSourceHash: "a".repeat(64),
      },
      { siteId, action: "assignSchema", objectId: 2, schemaId: "machine", expectedRevision: 1 },
      {
        siteId,
        action: "writeTemplateContent",
        objectId: 2,
        templateContent: { hero_title: "Ring Die Pellet Mill" },
        expectedRevision: 1,
      },
      {
        siteId,
        action: "writeTranslationDraft",
        jobToken: "token",
        values: { "/post/title": "Ring Die Pellet Mill" },
        expectedRevision: 0,
      },
      {
        siteId,
        action: "publishTranslation",
        subject: { kind: "post", id: 2 },
        locale: "en",
        expectedRevision: 1,
      },
      {
        siteId,
        action: "unpublishTranslation",
        subject: { kind: "post", id: 2 },
        locale: "en",
        expectedRevision: 2,
      },
    ];
    for (const input of valid) expect(decodeContentInput(input)._tag).toBe("Success");
    expect(decodeContentInput({ siteId, action: "writeDraft" })._tag).toBe("Failure");
  });

  it("projects non-empty provider-safe schemas while keeping exact decoders strict", () => {
    expect(InspectProviderProjection._tag).toBe("Success");
    expect(ContentProviderProjection._tag).toBe("Success");
    if (InspectProviderProjection._tag === "Success") {
      const schema = InspectProviderProjection.value;
      expect(Value.Check(schema, { siteId, resource: "translationJob" })).toBe(true);
      expect(decodeInspectInput({ siteId, resource: "translationJob" })._tag).toBe("Failure");
    }
    if (ContentProviderProjection._tag === "Success") {
      const schema = ContentProviderProjection.value;
      expect(Value.Check(schema, { siteId, action: "writeTranslationDraft" })).toBe(true);
      expect(decodeContentInput({ siteId, action: "writeTranslationDraft" })._tag).toBe("Failure");
    }
    expect(
      Value.Check(InspectInputContract, {
        siteId,
        resource: "translationJob",
        subject: { kind: "post", id: 1 },
        locale: "en",
      }),
    ).toBe(true);
    expect(
      Value.Check(ContentInputContract, {
        siteId,
        action: "publishTranslation",
        subject: { kind: "post", id: 1 },
        locale: "en",
        expectedRevision: 1,
      }),
    ).toBe(true);
  });
});
