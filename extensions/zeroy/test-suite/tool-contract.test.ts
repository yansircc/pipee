import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "@effect/vitest";
import {
  ContentInputContract,
  ContentProviderProjection,
  InspectInputContract,
  InspectProviderProjection,
  ThemeApplyInputContract,
  decodeContentInput,
  decodeInspectInput,
  providerSafeParameters,
} from "../src/domain/protocol.js";
import piZeroY from "../src/pi/extension.js";

type ObjectSchema = TSchema & {
  readonly properties: Readonly<
    Record<string, TSchema & { readonly enum?: ReadonlyArray<string> }>
  >;
  readonly required: ReadonlyArray<string>;
};

const siteId = "acceptance";

describe("zeroY exact tool input algebra", () => {
  it("accepts all configured-site and per-site inspect variants", () => {
    const inputs = [
      { resource: "sites" },
      { siteId, resource: "site" },
      { siteId, resource: "schema" },
      { siteId, resource: "inventory", page: 1, perPage: 50 },
      { siteId, resource: "acf" },
      { siteId, resource: "adoptionCandidates", schemaId: "showcase", page: 1, perPage: 50 },
      { siteId, resource: "existingPost", postId: 1 },
      { siteId, resource: "themeFiles", path: "style.css" },
      { siteId, resource: "localeContent", objectId: 1, locale: "zh-CN" },
      { siteId, resource: "themeCopy", locale: "zh-CN" },
      { siteId, resource: "integrity" },
      { siteId, resource: "externalCheck" },
    ];
    expect(inputs.every((input) => Value.Check(InspectInputContract, input))).toBe(true);
    expect(inputs.every((input) => decodeInspectInput(input)._tag === "Success")).toBe(true);
  });

  it("accepts all page, adoption, and ThemeCopy content variants", () => {
    const inputs = [
      {
        siteId,
        action: "siteConfig",
        siteConfig: {
          defaultLocale: "zh-CN",
          enabledLocales: [{ locale: "zh-CN", label: "中文", urlPrefix: "" }],
        },
        expectedRevision: 0,
      },
      {
        siteId,
        action: "createCanonical",
        postType: "page",
        schemaId: "showcase",
        postTitle: "Acceptance page",
      },
      {
        siteId,
        action: "adoptCanonical",
        postId: 2,
        schemaId: "showcase",
        expectedSourceHash: "a".repeat(64),
      },
      { siteId, action: "assignSchema", objectId: 1, schemaId: "showcase", expectedRevision: 1 },
      {
        siteId,
        action: "writeDraft",
        objectId: 1,
        locale: "zh-CN",
        schemaId: "showcase",
        route: "acceptance",
        document: { title: "标题", intro: "正文" },
        expectedRevision: 0,
      },
      { siteId, action: "publish", objectId: 1, locale: "zh-CN", expectedRevision: 1 },
      { siteId, action: "unpublish", objectId: 1, locale: "zh-CN", expectedRevision: 2 },
      {
        siteId,
        action: "writeThemeCopyDraft",
        locale: "zh-CN",
        document: { "nav.home": "首页" },
        expectedRevision: 0,
      },
      { siteId, action: "publishThemeCopy", locale: "zh-CN", expectedRevision: 1 },
      { siteId, action: "unpublishThemeCopy", locale: "zh-CN", expectedRevision: 2 },
    ];
    expect(inputs.every((input) => Value.Check(ContentInputContract, input))).toBe(true);
    expect(inputs.every((input) => decodeContentInput(input)._tag === "Success")).toBe(true);
  });

  it("reports unknown discriminators and missing fields against one selected variant", () => {
    const unknown = decodeInspectInput({ siteId, resource: "mystery" });
    expect(unknown).toMatchObject({
      _tag: "Failure",
      error: {
        message:
          "resource must be one of [sites, site, schema, inventory, acf, adoptionCandidates, existingPost, themeFiles, localeContent, themeCopy, integrity, externalCheck].",
      },
    });
    for (const [action, fields] of [
      ["siteConfig", "siteConfig, expectedRevision"],
      ["createCanonical", "postType, schemaId"],
      ["adoptCanonical", "postId, schemaId, expectedSourceHash"],
      ["assignSchema", "objectId, schemaId, expectedRevision"],
      ["writeDraft", "objectId, locale, schemaId, route, document, expectedRevision"],
      ["publish", "objectId, locale, expectedRevision"],
      ["unpublish", "objectId, locale, expectedRevision"],
      ["writeThemeCopyDraft", "locale, document, expectedRevision"],
      ["publishThemeCopy", "locale, expectedRevision"],
      ["unpublishThemeCopy", "locale, expectedRevision"],
    ] as const) {
      const incomplete = decodeContentInput({ siteId, action });
      expect(incomplete).toMatchObject({
        _tag: "Failure",
        error: { message: `action ${action} requires fields: ${fields}.` },
      });
    }
  });
});

describe("provider-safe tool projection", () => {
  it("projects inspect as a non-empty object with the complete enum", () => {
    expect(InspectProviderProjection._tag).toBe("Success");
    if (InspectProviderProjection._tag === "Failure") return;
    const schema = InspectProviderProjection.value as ObjectSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["resource"]);
    expect(schema.properties.resource?.enum).toEqual([
      "sites",
      "site",
      "schema",
      "inventory",
      "acf",
      "adoptionCandidates",
      "existingPost",
      "themeFiles",
      "localeContent",
      "themeCopy",
      "integrity",
      "externalCheck",
    ]);
    expect(Object.keys(schema.properties)).toEqual([
      "resource",
      "siteId",
      "page",
      "perPage",
      "postType",
      "schemaId",
      "postId",
      "path",
      "objectId",
      "locale",
    ]);
    expect(Value.Check(schema, { resource: "sites" })).toBe(true);
    expect(schema.properties.objectId?.description).toContain(
      "Required when resource = localeContent",
    );
  });

  it("projects content guidance without widening the exact decoder", () => {
    expect(ContentProviderProjection._tag).toBe("Success");
    if (ContentProviderProjection._tag === "Failure") return;
    const schema = ContentProviderProjection.value as ObjectSchema;
    expect(schema.required).toEqual(["siteId", "action"]);
    expect(schema.properties.action?.enum).toEqual([
      "siteConfig",
      "createCanonical",
      "adoptCanonical",
      "assignSchema",
      "writeDraft",
      "publish",
      "unpublish",
      "writeThemeCopyDraft",
      "publishThemeCopy",
      "unpublishThemeCopy",
    ]);
    expect(schema.properties.expectedRevision?.description).toContain(
      "A new LocaleHead always starts at 0",
    );
    expect(schema.properties.expectedRevision?.description).toContain(
      "canonical revision returned by createCanonical",
    );
    expect(schema.properties.postTitle?.description).toContain(
      "meaningful WordPress administrator title",
    );
    expect(schema.properties.expectedSourceHash?.description).toContain(
      "WordPress post and ACF facts have not changed",
    );
    expect(Value.Check(schema, { siteId, action: "writeDraft" })).toBe(true);
    expect(decodeContentInput({ siteId, action: "writeDraft" })._tag).toBe("Failure");
  });

  it("fails closed when variants disagree about one field constraint", () => {
    const conflict = Type.Union([
      Type.Object({ action: Type.Literal("one"), value: Type.String() }),
      Type.Object({ action: Type.Literal("two"), value: Type.Number() }),
    ]);
    expect(providerSafeParameters(conflict, "action")).toMatchObject({
      _tag: "Failure",
      error: { message: "Conflicting definitions for field value in action union." },
    });
  });

  it("keeps theme hash preconditions visible", () => {
    const schema = ThemeApplyInputContract as ObjectSchema;
    const files = schema.properties.files as TSchema & {
      readonly items: ObjectSchema;
    };
    expect(files.items.properties.expectedHash?.description).toContain(
      "existing file; use null for a new file",
    );
  });
});

describe("registered tool definitions", () => {
  it("publishes exactly three tools using the provider-safe projections", () => {
    const tools: Array<{
      readonly name: string;
      readonly description: string;
      readonly parameters: TSchema;
    }> = [];
    const pi = {
      registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
      on: () => undefined,
    } as unknown as ExtensionAPI;

    piZeroY(pi);

    expect(tools.map(({ name }) => name)).toEqual([
      "zeroy_inspect",
      "zeroy_theme_apply",
      "zeroy_content_apply",
    ]);
    expect(InspectProviderProjection._tag).toBe("Success");
    expect(ContentProviderProjection._tag).toBe("Success");
    if (
      InspectProviderProjection._tag === "Failure" ||
      ContentProviderProjection._tag === "Failure"
    )
      return;
    expect(tools[0]?.parameters).toBe(InspectProviderProjection.value);
    expect(tools[1]?.parameters).toBe(ThemeApplyInputContract);
    expect(tools[2]?.parameters).toBe(ContentProviderProjection.value);
    expect(tools[2]?.description).toContain(
      "adoptionCandidates → existingPost → adoptCanonical with expectedSourceHash",
    );
  });
});
