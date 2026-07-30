import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data } from "effect";

const SiteId = Type.String({ minLength: 1, description: "Configured zeroY site identifier." });
const Locale = Type.String({ minLength: 1 });
const Document = Type.Record(Type.String({ minLength: 1 }), Type.String());
const ThemeCopyPatch = Type.Record(
  Type.String({ minLength: 1 }),
  Type.Union([Type.String(), Type.Null()]),
);
const LocaleConfig = Type.Object({
  locale: Locale,
  label: Type.String({ minLength: 1 }),
  urlPrefix: Type.String(),
});
const SiteConfig = Type.Object({
  defaultLocale: Locale,
  enabledLocales: Type.Array(LocaleConfig, { minItems: 1 }),
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
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("themeFiles"),
    path: Type.Optional(
      Type.String({
        description:
          "Omit path to list active-theme paths with hash and size. Provide one existing path to read its exact content and hash before a write.",
      }),
    ),
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("localeContent"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
  }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("themeCopy"),
    locale: Locale,
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("integrity") }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("externalCheck") }),
]);
export type InspectInput = Static<typeof InspectInputContract>;

export const ThemeApplyInputContract = Type.Object({
  siteId: SiteId,
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      expectedHash: Type.Union([Type.String({ minLength: 64, maxLength: 64 }), Type.Null()], {
        description:
          "Use the hash returned by themeFiles for an existing file; use null for a new file.",
      }),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});
export type ThemeApplyInput = Static<typeof ThemeApplyInputContract>;

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
    action: Type.Literal("writeDraft"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    schemaId: Type.String({ minLength: 1 }),
    route: Type.String({ minLength: 1 }),
    document: Document,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The locale revision, independent from the canonical revision. A new LocaleHead always starts at 0; later calls must use the locale revision returned by the previous LocaleMutationReceipt.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("commit"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    schemaId: Type.String({ minLength: 1 }),
    route: Type.String({ minLength: 1 }),
    document: Document,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The locale revision returned by the Connector. commit writes one immutable LocaleVersion and advances both draft and published pointers atomically.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("publish"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The locale revision returned by the preceding writeDraft result.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("unpublish"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The current locale revision returned by the Connector.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("writeThemeCopyDraft"),
    locale: Locale,
    document: Document,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The ThemeCopy locale revision. A new ThemeCopy LocaleHead always starts at 0; later calls must use the revision returned by the previous ThemeCopy receipt.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("patchThemeCopyDraft"),
    locale: Locale,
    changes: ThemeCopyPatch,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The ThemeCopy locale revision. Each string sets one NodeId; null removes one NodeId from the current draft, or published document when no draft exists.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("commitThemeCopy"),
    locale: Locale,
    document: Document,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The ThemeCopy locale revision. commitThemeCopy writes one immutable ThemeCopy version and advances both draft and published pointers atomically.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("publishThemeCopy"),
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description:
        "The ThemeCopy locale revision returned by the preceding writeThemeCopyDraft result.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("unpublishThemeCopy"),
    locale: Locale,
    expectedRevision: Type.Integer({
      minimum: 0,
      description: "The current ThemeCopy locale revision returned by the Connector.",
    }),
  }),
  Type.Object({
    siteId: SiteId,
    action: Type.Literal("reconcileSchema"),
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
  "Begin with zeroy_inspect resource sites, then inspect the selected site. Standard page flow: createCanonical with postTitle, or adoptionCandidates → existingPost → adoptCanonical with expectedSourceHash; then commit with expectedRevision 0 when content is ready to publish, or writeDraft → inspect previewUrl → publish when a draft review is needed. Standard ThemeCopy flow: patchThemeCopyDraft for small changes, then publishThemeCopy; use commitThemeCopy when no review is needed. ThemeSchema writes automatically hard-migrate valid stored documents; use reconcileSchema only to request the report again. WordPress/ACF facts remain canonical and are never copied into zeroY locale documents.";

export type JsonRecord = Readonly<Record<string, unknown>>;
