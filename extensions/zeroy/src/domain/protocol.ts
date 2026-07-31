import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data } from "effect";

const SiteId = Type.String({ minLength: 1, description: "Configured zeroY site identifier." });
const Locale = Type.String({ minLength: 1 });
const JsonValue = Type.Recursive((Self) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);
export const SubjectRef = Type.Union(
  [
    Type.Object({ kind: Type.Literal("post"), id: Type.Integer({ minimum: 1 }) }),
    Type.Object({
      kind: Type.Literal("term"),
      taxonomy: Type.String({ minLength: 1 }),
      id: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({ kind: Type.Literal("menu"), id: Type.Integer({ minimum: 1 }) }),
    Type.Object({ kind: Type.Literal("site-copy"), id: Type.Literal("default") }),
    Type.Object({ kind: Type.Literal("media"), id: Type.Integer({ minimum: 1 }) }),
  ],
  { description: "The LocalizableSubject for translationJob or publishTranslation." },
);
export const TranslationProfileContract = Type.Object({
  contract: Type.Literal("zeroy/translation-profile@1"),
  companySummary: Type.String({ maxLength: 12000 }),
  targetAudience: Type.String({ maxLength: 12000 }),
  brandVoice: Type.String({ maxLength: 12000 }),
  localeGuidance: Type.Record(Type.String(), Type.String({ maxLength: 12000 })),
  glossary: Type.Array(
    Type.Object({
      source: Type.String(),
      translations: Type.Record(Type.String(), Type.String()),
      note: Type.Optional(Type.String()),
    }),
  ),
  protectedTerms: Type.Array(Type.String()),
});
export const LocalizationModeContract = Type.Union([
  Type.Literal("shared"),
  Type.Literal("translated"),
  Type.Literal("overridable"),
  Type.Literal("derived"),
]);
export const LocalizationPolicyContract = Type.Object({
  contract: Type.Literal("zeroy/localization-policy@1"),
  rules: Type.Array(
    Type.Object({
      fieldPattern: Type.String({ minLength: 1 }),
      mode: LocalizationModeContract,
      required: Type.Optional(Type.Boolean()),
      contextWeight: Type.Optional(
        Type.Union([Type.Literal("primary"), Type.Literal("supporting"), Type.Literal("hidden")]),
      ),
    }),
  ),
});
const LocaleValueContract = Type.Object({
  sourceHash: Type.String({ minLength: 64, maxLength: 64 }),
  value: JsonValue,
});
export const LocaleOverlayContract = Type.Object({
  contract: Type.Literal("zeroy/locale-overlay@1"),
  subject: SubjectRef,
  locale: Locale,
  policyHash: Type.String({ minLength: 64, maxLength: 64 }),
  values: Type.Record(Type.String({ pattern: "^/" }), LocaleValueContract),
  createdAt: Type.String({ minLength: 1 }),
});
export const TranslationJobContract = Type.Object({
  contract: Type.Literal("zeroy/translation-job@1"),
  subject: SubjectRef,
  locale: Locale,
  policyHash: Type.String({ minLength: 64, maxLength: 64 }),
  jobToken: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
  profile: TranslationProfileContract,
  fields: Type.Array(
    Type.Object({
      fieldId: Type.String({ pattern: "^/" }),
      label: Type.String({ minLength: 1 }),
      mode: Type.Union([Type.Literal("translated"), Type.Literal("overridable")]),
      sourceValue: JsonValue,
      sourceHash: Type.String({ minLength: 64, maxLength: 64 }),
      currentValue: Type.Optional(JsonValue),
      status: Type.Union([
        Type.Literal("missing"),
        Type.Literal("current"),
        Type.Literal("stale"),
        Type.Literal("review-needed"),
      ]),
      required: Type.Boolean(),
      context: Type.Optional(Type.Record(Type.String(), JsonValue)),
    }),
  ),
  contextFacts: Type.Array(
    Type.Object({
      fieldId: Type.String({ pattern: "^/" }),
      label: Type.String({ minLength: 1 }),
      value: JsonValue,
    }),
  ),
  summary: Type.Object({
    missing: Type.Integer({ minimum: 0 }),
    stale: Type.Integer({ minimum: 0 }),
    reviewNeeded: Type.Integer({ minimum: 0 }),
    current: Type.Integer({ minimum: 0 }),
    shared: Type.Integer({ minimum: 0 }),
    derived: Type.Integer({ minimum: 0 }),
  }),
  previewUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});
const LocaleConfig = Type.Object({
  locale: Locale,
  label: Type.String({ minLength: 1 }),
  urlPrefix: Type.String(),
});
const SiteConfig = Type.Object({
  defaultLocale: Locale,
  enabledLocales: Type.Array(LocaleConfig, { minItems: 1 }),
  translationProfile: TranslationProfileContract,
  siteCopy: Type.Record(Type.String({ minLength: 1 }), Type.String({ maxLength: 12000 })),
});
const SourceHash = Type.String({
  minLength: 64,
  maxLength: 64,
  description:
    "Exact sourceHash returned by adoptionCandidates or existingPost. It proves the WordPress post and ACF facts have not changed before identity-only adoption.",
});

export const InspectInputContract = Type.Union([
  Type.Object({
    resource: Type.Literal("sites"),
  }),
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
    resource: Type.Literal("canonicalContent"),
    objectId: Type.Integer({
      minimum: 1,
      description:
        "Canonical object ID. Returns its current default-locale resolved projection and canonical revision before a TemplateContent write.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("adoptionCandidates"),
    postType: Type.Optional(Type.String({ minLength: 1 })),
    schemaId: Type.Optional(Type.String({ minLength: 1 })),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("existingPost"),
    postId: Type.Integer({
      minimum: 1,
      description:
        "An unmanaged WordPress post ID returned by adoptionCandidates. Returns its canonical WordPress fields and current ACF values without creating zeroY content.",
    }),
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("siteRelease") }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("siteReleaseArtifact"),
    artifactId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    kind: Type.Union([Type.Literal("theme"), Type.Literal("siteLogic")]),
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("translationJob"),
    subject: SubjectRef,
    locale: Locale,
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("integrity") }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("externalCheck"),
    urls: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
        maxItems: 20,
        description:
          "Optional same-origin URLs to check in addition to published inventory pages. Use this for a draft preview or a just-published route; URLs outside the configured site origin are rejected.",
      }),
    ),
  }),
]);
export type InspectInput = Static<typeof InspectInputContract>;

export const SiteCheckoutInputContract = Type.Object({
  siteId: SiteId,
});
export type SiteCheckoutInput = Static<typeof SiteCheckoutInputContract>;

export const SiteVerifyInputContract = Type.Object({
  siteId: SiteId,
  checkoutId: Type.String({
    minLength: 1,
    description: "The checkoutId returned by zeroy_site_checkout.",
  }),
});
export type SiteVerifyInput = Static<typeof SiteVerifyInputContract>;

export const SitePushInputContract = Type.Object({
  siteId: SiteId,
  checkoutId: Type.String({
    minLength: 1,
    description: "The checkoutId returned by zeroy_site_checkout.",
  }),
  message: Type.Optional(
    Type.String({ maxLength: 500, description: "Optional deployment provenance message." }),
  ),
});
export type SitePushInput = Static<typeof SitePushInputContract>;

export const ContentInputContract = Type.Union([
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("siteConfig"),
    siteConfig: SiteConfig,
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The current SiteConfig revision returned by the Connector.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("createCanonical"),
    postType: Type.String({ minLength: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    postTitle: Type.Optional(
      Type.String({
        description:
          "Provide a meaningful WordPress administrator title instead of leaving the generated canonical object unnamed.",
      }),
    ),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("adoptCanonical"),
    postId: Type.Integer({
      minimum: 1,
      description:
        "Existing unmanaged WordPress post ID. Adoption attaches zeroY identity and a ThemeSchema; it does not copy or translate existing ACF values.",
    }),
    schemaId: Type.String({ minLength: 1 }),
    expectedSourceHash: SourceHash,
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("assignSchema"),
    objectId: Type.Integer({ minimum: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The canonical revision returned by createCanonical or the inventory.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("writeTemplateContent"),
    objectId: Type.Integer({ minimum: 1 }),
    templateContent: Type.Record(
      Type.String({ pattern: "^[a-z][a-z0-9_]{0,95}$" }),
      Type.String({ maxLength: 12000 }),
      {
        description:
          "A partial patch of ThemeSchema-declared templateContent text fields. Read canonicalContent first; undeclared keys are rejected.",
      },
    ),
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The canonical revision returned by canonicalContent. TemplateContent is default-locale WordPress post-meta and uses canonical optimistic concurrency.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("writeTranslationDraft"),
    jobToken: Type.String({
      minLength: 1,
      description:
        "The exact jobToken from translationJob; it proves the canonical revision, policy and locale revision are current.",
    }),
    values: Type.Record(Type.String({ pattern: "^/" }), Type.Union([JsonValue, Type.Null()])),
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The expectedRevision returned by translationJob. A new LocaleOverlay starts at 0 and is independent from canonical revision.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("publishTranslation"),
    subject: SubjectRef,
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The locale revision returned by writeTranslationDraft.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("unpublishTranslation"),
    subject: SubjectRef,
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The current locale revision. Unpublishing only removes the public pointer and preserves immutable draft history.",
    }),
  }),
]);
export type ContentApplyInput = Static<typeof ContentInputContract>;

type JsonSchema = TSchema & {
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
};

type Variant = {
  readonly value: string;
  readonly schema: JsonSchema;
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: ReadonlySet<string>;
};

const plainSchema = (schema: JsonSchema): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => plainSchema(item as JsonSchema));
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "description")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, plainSchema(value as JsonSchema)]),
  );
};

export class ProviderSchemaProjectionError extends Data.TaggedError(
  "ProviderSchemaProjectionError",
)<{
  readonly message: string;
}> {}

export type ProtocolResult<Success, Failure> =
  | { readonly _tag: "Success"; readonly value: Success }
  | { readonly _tag: "Failure"; readonly error: Failure };

const success = <Success>(value: Success): ProtocolResult<Success, never> => ({
  _tag: "Success",
  value,
});
const failure = <Failure>(error: Failure): ProtocolResult<never, Failure> => ({
  _tag: "Failure",
  error,
});

const variantsOf = (
  contract: JsonSchema,
  discriminator: string,
): ReadonlyArray<Variant> | ProviderSchemaProjectionError => {
  if (!Array.isArray(contract.anyOf) || contract.anyOf.length === 0) {
    return new ProviderSchemaProjectionError({
      message: "Provider-safe projection requires a non-empty discriminated union.",
    });
  }
  const seen = new Set<string>();
  const variants: Variant[] = [];
  for (const schema of contract.anyOf) {
    const properties = schema.properties;
    const value = properties?.[discriminator]?.const;
    if (!properties || typeof value !== "string") {
      return new ProviderSchemaProjectionError({
        message: `Every union member must define literal discriminator ${discriminator}.`,
      });
    }
    if (seen.has(value)) {
      return new ProviderSchemaProjectionError({
        message: `Duplicate ${discriminator} value: ${value}.`,
      });
    }
    seen.add(value);
    variants.push({
      value,
      schema,
      properties,
      required: new Set(schema.required ?? []),
    });
  }
  return variants;
};

const conditionalDescription = (
  field: string,
  discriminator: string,
  variants: ReadonlyArray<Variant>,
): string | undefined => {
  const users = variants.filter((variant) => field in variant.properties);
  const requiredBy = users
    .filter((variant) => variant.required.has(field))
    .map(({ value }) => value);
  const parts: string[] = [];
  if (requiredBy.length > 0 && requiredBy.length < variants.length) {
    parts.push(`Required when ${discriminator} = ${requiredBy.join(" or ")}.`);
  }
  const guidance = new Map<string, string[]>();
  for (const variant of users) {
    const description = variant.properties[field]?.description;
    if (typeof description !== "string" || description.length === 0) continue;
    const values = guidance.get(description) ?? [];
    values.push(variant.value);
    guidance.set(description, values);
  }
  for (const [description, values] of guidance) {
    parts.push(
      users.length === 1 || values.length === variants.length
        ? description
        : `When ${discriminator} = ${values.join(" or ")}: ${description}`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
};

/**
 * Projects one exact discriminated union into the top-level object shape required by
 * providers whose tool transport drops root anyOf. The union remains the only source
 * of discriminator values, field constraints, and conditional requirements.
 */
export const providerSafeParameters = (
  contract: TSchema,
  discriminator: "resource" | "action",
): ProtocolResult<TSchema, ProviderSchemaProjectionError> => {
  const variantsResult = variantsOf(contract as JsonSchema, discriminator);
  if (variantsResult instanceof ProviderSchemaProjectionError) return failure(variantsResult);
  const variants = variantsResult;
  const fields = new Map<string, JsonSchema[]>();
  for (const variant of variants) {
    for (const [field, schema] of Object.entries(variant.properties)) {
      const definitions = fields.get(field) ?? [];
      definitions.push(schema);
      fields.set(field, definitions);
    }
  }

  const properties: Record<string, TSchema> = {};
  for (const [field, definitions] of fields) {
    if (field === discriminator) {
      properties[field] = Type.String({
        enum: variants.map(({ value }) => value),
        description: `One of: ${variants.map(({ value }) => value).join(", ")}.`,
      });
      continue;
    }
    const baseline = JSON.stringify(plainSchema(definitions[0] as JsonSchema));
    if (definitions.some((schema) => JSON.stringify(plainSchema(schema)) !== baseline)) {
      return failure(
        new ProviderSchemaProjectionError({
          message: `Conflicting definitions for field ${field} in ${discriminator} union.`,
        }),
      );
    }
    const description = conditionalDescription(field, discriminator, variants);
    properties[field] = description
      ? ({ ...definitions[0], description } as TSchema)
      : (definitions[0] as TSchema);
  }

  const universallyRequired = new Set(
    [...fields.keys()].filter((field) => variants.every((variant) => variant.required.has(field))),
  );
  return success(
    Type.Object(
      Object.fromEntries(
        Object.entries(properties).map(([field, schema]) => [
          field,
          universallyRequired.has(field) ? schema : Type.Optional(schema),
        ]),
      ),
      { additionalProperties: false },
    ),
  );
};

export class ToolInputValidationError extends Data.TaggedError("ToolInputValidationError")<{
  readonly message: string;
}> {}

const decodeDiscriminated = <Output>(
  contract: TSchema,
  discriminator: "resource" | "action",
  input: unknown,
): ProtocolResult<Output, ToolInputValidationError | ProviderSchemaProjectionError> => {
  const variantsResult = variantsOf(contract as JsonSchema, discriminator);
  if (variantsResult instanceof ProviderSchemaProjectionError) return failure(variantsResult);
  const variants = variantsResult;
  const value =
    typeof input === "object" && input !== null
      ? (input as Readonly<Record<string, unknown>>)[discriminator]
      : undefined;
  const selected = variants.find((variant) => variant.value === value);
  if (!selected) {
    return failure(
      new ToolInputValidationError({
        message: `${discriminator} must be one of [${variants.map((variant) => variant.value).join(", ")}].`,
      }),
    );
  }
  if (Value.Check(selected.schema, input)) return success(input as Output);
  const missing = [...selected.required].filter(
    (field) => typeof input !== "object" || input === null || !(field in input),
  );
  if (missing.length > 0) {
    return failure(
      new ToolInputValidationError({
        message: `${discriminator} ${selected.value} requires fields: ${missing.join(", ")}.`,
      }),
    );
  }
  const issues = [...Value.Errors(selected.schema, input)]
    .map((issue) => `${issue.path || "input"}: ${issue.message}`)
    .join("; ");
  return failure(
    new ToolInputValidationError({
      message: `Invalid ${discriminator} ${selected.value} input: ${issues}`,
    }),
  );
};

export const InspectProviderProjection = providerSafeParameters(InspectInputContract, "resource");
export const ContentProviderProjection = providerSafeParameters(ContentInputContract, "action");

export const decodeInspectInput = (input: unknown) =>
  decodeDiscriminated<InspectInput>(InspectInputContract, "resource", input);
export const decodeContentInput = (input: unknown) =>
  decodeDiscriminated<ContentApplyInput>(ContentInputContract, "action", input);

export const CONTENT_PROMPT_GUIDELINES =
  "Begin with zeroy_inspect resource sites, then inspect the selected site. Standard page flow: createCanonical with postTitle, or adoptionCandidates → existingPost → adoptCanonical with expectedSourceHash. If the active ThemeSchema declares templateContent, read canonicalContent and writeTemplateContent with its canonical revision. Standard translation flow: inspect translationJob for a subject and target locale, writeTranslationDraft with only the returned writable field values and expectedRevision 0 for a new Overlay, inspect previewUrl, then publishTranslation with the returned revision. Use unpublishTranslation only to remove a published locale route while preserving immutable drafts. Never submit inherit decisions, source hashes, raw ACF trees, or shared facts: ThemeSchema owns that policy and LocaleOverlay stores only language-owned values.";

export type JsonRecord = Readonly<Record<string, unknown>>;
