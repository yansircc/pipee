import { Type, type Static } from "@sinclair/typebox";

const SiteId = Type.String({ minLength: 1 });
const Locale = Type.String({ minLength: 1 });
const Revision = Type.Integer({ minimum: 0 });
const Document = Type.Record(Type.String({ minLength: 1 }), Type.String());
const LocaleConfig = Type.Object({
  locale: Locale,
  label: Type.String({ minLength: 1 }),
  urlPrefix: Type.String(),
});
const SiteConfig = Type.Object({
  defaultLocale: Locale,
  enabledLocales: Type.Array(LocaleConfig, { minItems: 1 }),
});

export const InspectParameters = Type.Union([
  Type.Object({ siteId: SiteId, resource: Type.Literal("site") }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("schema") }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("inventory"),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("acf") }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("themeFiles"),
    path: Type.Optional(Type.String()),
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("localeContent"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("integrity") }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("externalCheck") }),
]);
export type InspectInput = Static<typeof InspectParameters>;

export const ThemeApplyParameters = Type.Object({
  siteId: SiteId,
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      expectedHash: Type.Union([Type.String({ minLength: 64, maxLength: 64 }), Type.Null()]),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});
export type ThemeApplyInput = Static<typeof ThemeApplyParameters>;

export const ContentApplyParameters = Type.Union([
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("siteConfig"),
    siteConfig: SiteConfig,
    expectedRevision: Revision,
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("createCanonical"),
    postType: Type.String({ minLength: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    postTitle: Type.Optional(Type.String()),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("assignSchema"),
    objectId: Type.Integer({ minimum: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    expectedRevision: Revision,
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("writeDraft"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    schemaId: Type.String({ minLength: 1 }),
    route: Type.String({ minLength: 1 }),
    document: Document,
    expectedRevision: Revision,
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("publish"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    expectedRevision: Revision,
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("unpublish"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    expectedRevision: Revision,
  }),
]);
export type ContentApplyInput = Static<typeof ContentApplyParameters>;

export type JsonRecord = Readonly<Record<string, unknown>>;
