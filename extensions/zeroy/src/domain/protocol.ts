import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data } from "effect";

const SiteId = Type.String({ minLength: 1, description: "Configured zeroY site identifier." });
const Locale = Type.String({ minLength: 1 });
// SiteDraft is also the connector's internal compiler log. Its receipt must
// describe either compiler artifact even though the Agent-facing write tool
// only permits ThemeArtifact changes.
const SiteArtifactKind = Type.Union([Type.Literal("theme"), Type.Literal("site-logic")]);
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
export const DraftSubjectRef = Type.Union([
  Type.Object({ kind: Type.Literal("post"), id: Type.Integer({ minimum: 1 }) }),
  Type.Object({ kind: Type.Literal("post"), ref: Type.String({ minLength: 1 }) }),
  Type.Object({
    kind: Type.Literal("term"),
    taxonomy: Type.String({ minLength: 1 }),
    id: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({ kind: Type.Literal("site-copy"), id: Type.Literal("default") }),
]);
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
    "Exact sourceHash returned by zeroy_inspect resource content. It proves the WordPress post and ACF facts have not changed before identity-only adoption.",
});
const DraftRevision = Type.Integer({
  minimum: 0,
  description:
    "Revision in the SiteDraft projection. Revisions belong to their own subject: a new locale starts at 0 independently from its canonical object; every later operation uses the revision returned by the preceding receipt.",
});
const ExplicitRoute = Type.String({
  minLength: 1,
  description:
    "Explicit public route relative to the locale prefix. Runtime never derives a public route from a WordPress slug.",
});
const ObjectRef = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]);
const TemplateContent = Type.Record(
  Type.String({ pattern: "^[a-z][a-z0-9_]{0,95}$" }),
  Type.String({ maxLength: 12000 }),
  {
    description: "ThemeSchema-declared templateContent values for this canonical object.",
  },
);

export const ContentInspectionContract = Type.Union([
  Type.Object({
    kind: Type.Literal("canonical"),
    objectId: Type.Integer({
      minimum: 1,
      description:
        "Canonical object ID. Returns its default-locale projection and canonical revision.",
    }),
  }),
  Type.Object({
    kind: Type.Literal("adoption-candidates"),
    postType: Type.Optional(Type.String({ minLength: 1 })),
    schemaId: Type.Optional(Type.String({ minLength: 1 })),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({
    kind: Type.Literal("existing-post"),
    postId: Type.Integer({
      minimum: 1,
      description:
        "Unmanaged WordPress post ID returned by adoption-candidates, including canonical fields and ACF facts.",
    }),
    schemaId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional prospective ThemeSchema ID. Returns the exact field IDs, repeater item keys, values, source hashes, and localization policies that this post would use after adoption.",
      }),
    ),
    draftId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Open SiteDraft whose candidate ThemeSchema should generate this FieldProjection. Requires schemaId; use this after staging a new schema and before staging adoption or translation operations.",
      }),
    ),
  }),
  Type.Object({
    kind: Type.Literal("translation"),
    subject: SubjectRef,
    locale: Locale,
  }),
]);
export type ContentInspection = Static<typeof ContentInspectionContract>;

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
  Type.Object({ siteId: SiteId, resource: Type.Literal("zcssContract") }),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("styleSurface"),
    draftId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Owner-scoped open SiteDraft. Omit to project the exact active SiteRelease StyleSurface.",
      }),
    ),
  }),
  Type.Object({ siteId: SiteId, resource: Type.Literal("release") }),
  Type.Object(
    {
      siteId: SiteId,
      resource: Type.Literal("draft"),
      draftId: Type.String({ minLength: 1 }),
    },
    {
      description:
        "Read the owner-scoped SiteDraft candidate, including artifactManifests whose entries are the current staged file hashes.",
    },
  ),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("proof"),
    proofId: Type.String({ minLength: 1 }),
  }),
  Type.Object(
    {
      siteId: SiteId,
      resource: Type.Literal("themeFiles"),
      path: Type.Optional(Type.String({ minLength: 1 })),
    },
    {
      description:
        "Read files from the active SiteRelease ThemeArtifact only. For current staged hashes, inspect resource draft and read candidate.artifactManifests.theme.entries.",
    },
  ),
  Type.Object({
    siteId: SiteId,
    resource: Type.Literal("content"),
    content: ContentInspectionContract,
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

export const SiteDraftReceiptContract = Type.Object({
  contract: Type.Literal("zeroy/site-draft@1"),
  draftId: Type.String({ minLength: 1 }),
  baseReleaseId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("committing"),
    Type.Literal("discarded"),
    Type.Literal("committed"),
    Type.Literal("replayed"),
  ]),
  operationCount: Type.Integer({ minimum: 0 }),
  operationsHash: Type.String({ minLength: 64, maxLength: 64 }),
  lastOperation: Type.Union([
    Type.Object({
      operationId: Type.String({ minLength: 1 }),
      kind: Type.String({ minLength: 1 }),
      nextRevision: Type.Union([
        Type.Integer({ minimum: 0 }),
        Type.Null({
          description:
            "No follow-up revision applies to this operation. A non-null value is the exact expectedRevision for the same staged subject's next mutation.",
        }),
      ]),
    }),
    Type.Null(),
  ]),
  proofId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  replayedFromDraftId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  diagnostics: Type.Record(Type.String(), JsonValue),
  operationSummaries: Type.Array(JsonValue),
  stagedRefs: Type.Record(Type.String(), JsonValue),
  affectedSubjects: Type.Array(JsonValue),
  affectedArtifacts: Type.Array(JsonValue),
  lastArtifactFiles: Type.Array(
    Type.Object({
      artifact: SiteArtifactKind,
      path: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal("written"), Type.Literal("deleted")]),
      hash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    }),
  ),
  zcss: Type.Union([
    Type.Object({
      contract: Type.Literal("zeroy/zcss-compiled-contract@1"),
      compiler: Type.Object({
        id: Type.Literal("zeroy/zcss-compiler@1"),
        version: Type.String({ minLength: 1 }),
        sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      }),
      designHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      outputHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      tokenCount: Type.Integer({ minimum: 0 }),
      primitiveCount: Type.Integer({ minimum: 0 }),
      warningCount: Type.Integer({ minimum: 0 }),
    }),
    Type.Null({
      description:
        "The open Draft does not yet contain a complete compilable ThemeManifest v3 and ZCSS design.",
    }),
  ]),
  createdAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
});
export type SiteDraftReceipt = Static<typeof SiteDraftReceiptContract>;

/**
 * `resource: draft` is not a second candidate store. It is the read-only
 * compilation of the same Draft operation log commit will use. Keep its
 * three states explicit so a malformed Connector response cannot become an
 * implicit authoring contract for an Agent.
 */
export const SiteDraftCandidateContract = Type.Union([
  Type.Object({
    contract: Type.Literal("zeroy/site-draft-candidate@1"),
    state: Type.Literal("ready"),
    draftId: Type.String({ minLength: 1 }),
    operationsHash: Type.String({ minLength: 64, maxLength: 64 }),
    themeContract: JsonValue,
    themeSchema: JsonValue,
    themeSchemaHash: Type.String({ minLength: 64, maxLength: 64 }),
    siteLogicContract: JsonValue,
    siteLogicContractHash: Type.String({ minLength: 64, maxLength: 64 }),
    acfProjection: JsonValue,
    artifactManifests: Type.Object({
      theme: JsonValue,
      siteLogic: JsonValue,
    }),
  }),
  Type.Object({
    contract: Type.Literal("zeroy/site-draft-candidate@1"),
    state: Type.Literal("invalid"),
    diagnostic: JsonValue,
  }),
  Type.Object({
    contract: Type.Literal("zeroy/site-draft-candidate@1"),
    state: Type.Literal("unavailable"),
    reason: Type.String({ minLength: 1 }),
  }),
]);
export type SiteDraftCandidate = Static<typeof SiteDraftCandidateContract>;

export const SiteDraftInspectionContract = Type.Object({
  contract: Type.Literal("zeroy/site-draft-inspection@1"),
  draft: SiteDraftReceiptContract,
  candidate: SiteDraftCandidateContract,
});
export type SiteDraftInspection = Static<typeof SiteDraftInspectionContract>;

/**
 * Agent authoring is scoped to the remote ThemeArtifact. SiteLogic is
 * connector-owned runtime code: it participates in CandidateProof but is not
 * an Agent-editable file tree. This keeps the public surface aligned with the
 * one capability users actually need (authoring their WordPress theme) while
 * leaving artifact composition an internal compiler concern.
 */
export const ThemeStageInputContract = Type.Object(
  {
    siteId: SiteId,
    draftId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Open SiteDraft; omit to create one from the current active release or an empty bootstrap base.",
      }),
    ),
    files: Type.Array(
      Type.Union([
        Type.Object({
          path: Type.String({
            minLength: 1,
            description: "Path relative to the candidate ThemeArtifact root.",
          }),
          content: Type.String({
            description: "Complete replacement bytes for a created or existing file.",
          }),
          expectedHash: Type.Union([
            Type.String({
              pattern: "^[a-f0-9]{64}$",
              description:
                "Current file hash. Read active hashes from themeFiles; after staging, recover the Draft hash from draft.candidate.artifactManifests.theme.entries.",
            }),
            Type.Null({ description: "Use only when creating a new file." }),
          ]),
        }),
        Type.Object({
          path: Type.String({
            minLength: 1,
            description: "Path relative to the candidate ThemeArtifact root.",
          }),
          content: Type.Null({ description: "Delete the existing file." }),
          expectedHash: Type.String({
            pattern: "^[a-f0-9]{64}$",
            description:
              "Current file hash. Read active hashes from themeFiles; after staging, recover the Draft hash from draft.candidate.artifactManifests.theme.entries.",
          }),
        }),
      ]),
      { minItems: 1, maxItems: 200 },
    ),
    message: Type.Optional(Type.String({ maxLength: 500 })),
  },
  {
    description:
      "Stage remote WordPress theme file changes into the current SiteDraft. Changes are not live until zeroy_site_commit succeeds.",
  },
);
export type ThemeStageInput = Static<typeof ThemeStageInputContract>;

export const ContentOperationContract = Type.Union([
  Type.Object({
    kind: Type.Literal("replayDraft"),
    sourceDraftId: Type.String({
      minLength: 1,
      description:
        "A stale open SiteDraft to replay as one complete immutable operation log onto the current active SiteRelease. Omit draftId for this operation; the returned receipt owns the new open draftId.",
    }),
  }),
  Type.Object({
    kind: Type.Literal("siteConfig"),
    siteConfig: SiteConfig,
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("createCanonical"),
    ref: Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    postType: Type.String({ minLength: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    route: ExplicitRoute,
    postTitle: Type.Optional(Type.String()),
    postContent: Type.Optional(
      Type.String({
        description:
          "Default-locale WordPress post content. Required when the selected ThemeSchema marks /post/content required.",
      }),
    ),
    postExcerpt: Type.Optional(Type.String()),
    templateContent: Type.Optional(TemplateContent),
  }),
  Type.Object({
    kind: Type.Literal("adoptCanonical"),
    postId: Type.Integer({ minimum: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    route: ExplicitRoute,
    expectedSourceHash: SourceHash,
  }),
  Type.Object({
    kind: Type.Literal("retireCanonical"),
    objectId: Type.Integer({
      minimum: 1,
      description:
        "Existing canonical object to remove from zeroY ownership while preserving the WordPress post.",
    }),
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("assignSchema"),
    objectRef: ObjectRef,
    schemaId: Type.String({ minLength: 1 }),
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("writeTemplateContent"),
    objectRef: ObjectRef,
    templateContent: TemplateContent,
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("writeCanonicalContent"),
    objectRef: ObjectRef,
    postTitle: Type.Optional(Type.String()),
    postContent: Type.Optional(Type.String()),
    postExcerpt: Type.Optional(Type.String()),
    route: Type.Optional(ExplicitRoute),
    acf: Type.Optional(Type.Record(Type.String({ minLength: 1 }), JsonValue)),
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("writeTranslationDraft"),
    subject: DraftSubjectRef,
    locale: Locale,
    values: Type.Record(Type.String({ pattern: "^/" }), Type.Union([JsonValue, Type.Null()])),
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("publishTranslation"),
    subject: DraftSubjectRef,
    locale: Locale,
    expectedRevision: DraftRevision,
  }),
  Type.Object({
    kind: Type.Literal("unpublishTranslation"),
    subject: DraftSubjectRef,
    locale: Locale,
    expectedRevision: DraftRevision,
  }),
]);
export type ContentOperation = Static<typeof ContentOperationContract>;

export const ContentStageInputContract = Type.Object({
  siteId: SiteId,
  draftId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Open SiteDraft; omit to create one from the current active release or an empty bootstrap base.",
    }),
  ),
  operation: ContentOperationContract,
});
export type ContentStageInput = Static<typeof ContentStageInputContract>;

export const SiteCommitInputContract = Type.Object({
  siteId: SiteId,
  draftId: Type.String({ minLength: 1 }),
  expectedBaseReleaseId: Type.Union([
    Type.String({ minLength: 1 }),
    Type.Null({
      description:
        "Use null only when the SiteDraft receipt has baseReleaseId null for the first SiteRelease.",
    }),
  ]),
  message: Type.Optional(Type.String({ maxLength: 500 })),
});
export type SiteCommitInput = Static<typeof SiteCommitInputContract>;

const BrowserViewportContract = Type.Object({
  id: Type.Union([Type.Literal("mobile"), Type.Literal("tablet"), Type.Literal("desktop")]),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
});
const BrowserContrastPairContract = Type.Object({
  id: Type.String({ minLength: 1 }),
  foreground: Type.String({ pattern: "^--z-" }),
  background: Type.String({ pattern: "^--z-" }),
  minimum: Type.Number({ minimum: 1 }),
});
export const BrowserVerificationChallengeContract = Type.Object({
  contract: Type.Literal("zeroy/browser-verification-challenge@1"),
  verifier: Type.Object({
    id: Type.Literal("zeroy/pi-browser-verifier@1"),
    version: Type.Literal("1"),
  }),
  releaseId: Type.String({ minLength: 1 }),
  themeArtifactId: Type.String({ minLength: 1 }),
  scenarioSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  stylesheetSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  stylesheets: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      url: Type.String({ minLength: 1 }),
    }),
    { minItems: 1 },
  ),
  viewports: Type.Array(BrowserViewportContract, { minItems: 3, maxItems: 3 }),
  contrastPairs: Type.Array(BrowserContrastPairContract, { minItems: 1 }),
  scenarios: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      kind: Type.String({ minLength: 1 }),
      locale: Type.String({ minLength: 1 }),
      url: Type.String({ minLength: 1 }),
      expectedStatus: Type.Integer({ minimum: 100, maximum: 599 }),
      expectedRouteKind: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
    { minItems: 1 },
  ),
  challengeHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export type BrowserVerificationChallenge = Static<typeof BrowserVerificationChallengeContract>;

const BrowserResultContract = Type.Object({
  scenario: Type.String({ minLength: 1 }),
  viewport: Type.String({ minLength: 1 }),
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  routeKind: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  stylesheetIdentity: Type.String(),
  stylesheets: Type.Array(Type.String()),
  documentClientWidth: Type.Integer({ minimum: 1 }),
  documentScrollWidth: Type.Integer({ minimum: 1 }),
  overflowElements: Type.Integer({ minimum: 0 }),
  overflowSamples: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
  mediaOverflowElements: Type.Integer({ minimum: 0 }),
  mediaOverflowSamples: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
  focusVisible: Type.Union([Type.Boolean(), Type.Null()]),
  reducedMotion: Type.Boolean(),
  contrastRatios: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0 })),
});
export const BrowserEvidenceContract = Type.Object({
  contract: Type.Literal("zeroy/browser-evidence@1"),
  challengeHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  releaseId: Type.String({ minLength: 1 }),
  themeArtifactId: Type.String({ minLength: 1 }),
  scenarioSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  stylesheetSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  verifier: Type.Object({
    id: Type.Literal("zeroy/pi-browser-verifier@1"),
    version: Type.Literal("1"),
    engine: Type.String({ minLength: 1 }),
    engineVersion: Type.String({ minLength: 1 }),
  }),
  results: Type.Array(BrowserResultContract, { minItems: 1 }),
});
export type BrowserEvidence = Static<typeof BrowserEvidenceContract>;

/** Compact public projection of the immutable SiteRelease fact. */
export const SiteReleaseReceiptContract = Type.Object({
  contract: Type.Literal("zeroy/site-release@1"),
  releaseId: Type.String({ minLength: 1 }),
  draftId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  themeArtifactId: Type.String({ minLength: 1 }),
  siteLogicArtifactId: Type.String({ minLength: 1 }),
  themeContractHash: Type.String({ minLength: 64, maxLength: 64 }),
  zcss: Type.Union([JsonValue, Type.Null()]),
  siteLogicContractHash: Type.String({ minLength: 64, maxLength: 64 }),
  storageEpoch: Type.Integer({ minimum: 0 }),
  snapshotHash: Type.String({ minLength: 64, maxLength: 64 }),
  expectedActiveReleaseId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  state: Type.Union([
    Type.Literal("preparing"),
    Type.Literal("awaiting-browser"),
    Type.Literal("prepared"),
    Type.Literal("failed"),
    Type.Literal("active"),
    Type.Literal("superseded"),
  ]),
  proofId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  activeReleaseId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  provenance: Type.Union([JsonValue, Type.Null()]),
  diagnostics: Type.Object({
    contract: Type.Literal("zeroy/site-release-diagnostics@1"),
    migration: Type.Union([JsonValue, Type.Null()]),
    proof: Type.Union([JsonValue, Type.Null()]),
  }),
  browserVerification: Type.Union([BrowserVerificationChallengeContract, Type.Null()]),
  affectedSubjects: Type.Array(JsonValue),
  affectedArtifacts: Type.Array(JsonValue),
  createdAt: Type.String({ minLength: 1 }),
  activatedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  previewUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});
export type SiteReleaseReceipt = Static<typeof SiteReleaseReceiptContract>;

type JsonSchema = TSchema & {
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly $id?: string;
  readonly $ref?: string;
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

const schemaAnnotations = new Set([
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

const withoutKey = (schema: JsonSchema, omitted: string): JsonSchema =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => key !== omitted)) as JsonSchema;

const collectProviderDefinitions = (
  value: unknown,
  definitions: Map<string, JsonSchema>,
): ProviderSchemaProjectionError | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = collectProviderDefinitions(item, definitions);
      if (error) return error;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const schema = value as JsonSchema;
  if (schema.$id !== undefined) {
    if (schema.$id.length === 0) {
      return new ProviderSchemaProjectionError({ message: "Provider schema $id cannot be empty." });
    }
    const body = withoutKey(schema, "$id");
    const existing = definitions.get(schema.$id);
    if (existing && JSON.stringify(plainSchema(existing)) !== JSON.stringify(plainSchema(body))) {
      return new ProviderSchemaProjectionError({
        message: `Provider schema definition ${schema.$id} has conflicting bodies.`,
      });
    }
    definitions.set(schema.$id, existing ?? body);
  }
  for (const nested of Object.values(schema)) {
    const error = collectProviderDefinitions(nested, definitions);
    if (error) return error;
  }
  return undefined;
};

const rewriteProviderReferences = (
  value: unknown,
  definitions: ReadonlyMap<string, JsonSchema>,
  active: ReadonlySet<string> = new Set(),
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteProviderReferences(item, definitions, active));
  }
  if (typeof value !== "object" || value === null) return value;
  const schema = value as JsonSchema;
  if (schema.$id !== undefined) {
    return rewriteProviderReferences(
      withoutKey(schema, "$id"),
      definitions,
      new Set([...active, schema.$id]),
    );
  }
  if (schema.$ref !== undefined && definitions.has(schema.$ref)) {
    const annotations = Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => schemaAnnotations.has(key))
        .map(([key, nested]) => [key, rewriteProviderReferences(nested, definitions, active)]),
    );
    if (active.has(schema.$ref)) return annotations;
    return {
      ...(rewriteProviderReferences(
        definitions.get(schema.$ref),
        definitions,
        new Set([...active, schema.$ref]),
      ) as Readonly<Record<string, unknown>>),
      ...annotations,
    };
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, nested]) => [
      key,
      rewriteProviderReferences(nested, definitions, active),
    ]),
  );
};

const resolveLocalSchemaReference = (root: JsonSchema, reference: string): unknown => {
  if (!reference.startsWith("#/")) return undefined;
  let cursor: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) return undefined;
    cursor = (cursor as Readonly<Record<string, unknown>>)[segment];
  }
  return cursor;
};

/** Validates the exact provider document that Pi is allowed to register. */
export const validateProviderSchemaDocument = (
  schema: unknown,
): ProtocolResult<TSchema, ProviderSchemaProjectionError> => {
  if (typeof schema !== "object" || schema === null || (schema as JsonSchema).type !== "object") {
    return failure(
      new ProviderSchemaProjectionError({
        message: 'Provider tool parameters must have top-level type "object".',
      }),
    );
  }
  const root = schema as JsonSchema;
  const visit = (value: unknown): ProviderSchemaProjectionError | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const error = visit(item);
        if (error) return error;
      }
      return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const node = value as JsonSchema;
    if (node.$ref !== undefined) {
      if (!node.$ref.startsWith("#/$defs/")) {
        return new ProviderSchemaProjectionError({
          message: `Provider schema reference must be local: ${node.$ref}.`,
        });
      }
      if (resolveLocalSchemaReference(root, node.$ref) === undefined) {
        return new ProviderSchemaProjectionError({
          message: `Provider schema reference is unresolved: ${node.$ref}.`,
        });
      }
      return new ProviderSchemaProjectionError({
        message: `Provider schema must be reference-free after projection: ${node.$ref}.`,
      });
    }
    for (const nested of Object.values(node)) {
      const error = visit(nested);
      if (error) return error;
    }
    return undefined;
  };
  const error = visit(root);
  return error ? failure(error) : success(root);
};

/**
 * Projects TypeBox's named recursion into a reference-free provider document.
 * A recursive edge becomes `{}`, the exact JSON Schema vocabulary for any JSON wire value;
 * the original recursive contract remains the execution decoder.
 */
export const closeProviderSchema = (
  schema: TSchema,
): ProtocolResult<TSchema, ProviderSchemaProjectionError> => {
  const definitions = new Map<string, JsonSchema>();
  const collectionError = collectProviderDefinitions(schema, definitions);
  if (collectionError) return failure(collectionError);
  const rewritten = rewriteProviderReferences(schema, definitions) as JsonSchema;
  return validateProviderSchemaDocument(rewritten);
};

const finalizeProviderProjection = (
  projection: ProtocolResult<TSchema, ProviderSchemaProjectionError>,
): ProtocolResult<TSchema, ProviderSchemaProjectionError> =>
  projection._tag === "Failure" ? projection : closeProviderSchema(projection.value);

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

const objectProperties = (
  contract: JsonSchema,
):
  | {
      readonly properties: Readonly<Record<string, JsonSchema>>;
      readonly required: ReadonlySet<string>;
    }
  | ProviderSchemaProjectionError => {
  if (!contract.properties) {
    return new ProviderSchemaProjectionError({
      message: "Provider-safe projection requires an object schema.",
    });
  }
  return { properties: contract.properties, required: new Set(contract.required ?? []) };
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
  discriminator: string,
  nested: Readonly<Record<string, TSchema>> = {},
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
    const replacement = nested[field];
    properties[field] = description
      ? ({ ...(replacement ?? definitions[0]), description } as TSchema)
      : ((replacement ?? definitions[0]) as TSchema);
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

/**
 * Reuses an exact object contract's stable fields while replacing nested unions
 * with their provider-safe projection. It prevents a second hand-written
 * transport shape from drifting away from the execution contract.
 */
export const providerSafeObject = (
  contract: TSchema,
  nested: Readonly<Record<string, TSchema>> = {},
): ProtocolResult<TSchema, ProviderSchemaProjectionError> => {
  const object = objectProperties(contract as JsonSchema);
  if (object instanceof ProviderSchemaProjectionError) return failure(object);
  return success(
    Type.Object(
      Object.fromEntries(
        Object.entries(object.properties).map(([field, schema]) => [
          field,
          object.required.has(field)
            ? (nested[field] ?? schema)
            : Type.Optional(nested[field] ?? schema),
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
  discriminator: string,
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
  const record = input as Readonly<Record<string, unknown>>;
  const allowedTransportFields = new Set(
    variants.flatMap((variant) => Object.keys(variant.properties)),
  );
  const unknown = Object.keys(record).filter((field) => !allowedTransportFields.has(field));
  if (unknown.length > 0) {
    return failure(
      new ToolInputValidationError({
        message: `${discriminator} ${selected.value} has unknown fields: ${unknown.join(", ")}.`,
      }),
    );
  }
  // Provider-safe schemas flatten every branch's fields into one object because
  // some providers drop root anyOf. Those fields are valid transport vocabulary,
  // but only the selected branch is execution vocabulary. Project them back to
  // the exact branch before validation so optional fields from other branches
  // cannot cross the Connector boundary.
  const branch = Object.fromEntries(
    Object.entries(record).filter(([field]) => field in selected.properties),
  );
  const exact = Type.Object(selected.properties as Record<string, TSchema>, {
    additionalProperties: false,
  });
  if (Value.Check(exact, branch)) return success(branch as Output);
  const missing = [...selected.required].filter((field) => !(field in branch));
  if (missing.length > 0) {
    return failure(
      new ToolInputValidationError({
        message: `${discriminator} ${selected.value} requires fields: ${missing.join(", ")}.`,
      }),
    );
  }
  const issues = [...Value.Errors(exact, branch)]
    .map((issue) => `${issue.path || "input"}: ${issue.message}`)
    .join("; ");
  return failure(
    new ToolInputValidationError({
      message: `Invalid ${discriminator} ${selected.value} input: ${issues}`,
    }),
  );
};

export const ContentInspectionProviderProjection = providerSafeParameters(
  ContentInspectionContract,
  "kind",
);
export const ContentOperationProviderProjection = providerSafeParameters(
  ContentOperationContract,
  "kind",
);
export const ThemeStageProviderProjection = finalizeProviderProjection(
  providerSafeObject(ThemeStageInputContract),
);
export const SiteCommitProviderProjection = finalizeProviderProjection(
  providerSafeObject(SiteCommitInputContract),
);
export const ContentStageProviderProjection =
  ContentOperationProviderProjection._tag === "Failure"
    ? ContentOperationProviderProjection
    : finalizeProviderProjection(
        providerSafeObject(ContentStageInputContract, {
          operation: ContentOperationProviderProjection.value,
        }),
      );
export const InspectProviderProjection =
  ContentInspectionProviderProjection._tag === "Failure"
    ? ContentInspectionProviderProjection
    : finalizeProviderProjection(
        providerSafeParameters(InspectInputContract, "resource", {
          content: ContentInspectionProviderProjection.value,
        }),
      );

export const decodeInspectInput = (input: unknown) => {
  const root = decodeDiscriminated<InspectInput>(InspectInputContract, "resource", input);
  if (
    typeof input === "object" &&
    input !== null &&
    (input as Readonly<Record<string, unknown>>).resource === "content"
  ) {
    const nested = decodeDiscriminated<ContentInspection>(
      ContentInspectionContract,
      "kind",
      (input as Readonly<Record<string, unknown>>).content,
    );
    if (nested._tag === "Failure") return nested;
    if (root._tag === "Success") {
      return success({ ...root.value, content: nested.value } as InspectInput);
    }
  }
  return root;
};

const decodeExact = <Output>(
  contract: TSchema,
  label: string,
  input: unknown,
): ProtocolResult<Output, ToolInputValidationError> => {
  const object = objectProperties(contract as JsonSchema);
  const exact =
    object instanceof ProviderSchemaProjectionError
      ? contract
      : Type.Object(object.properties as Record<string, TSchema>, { additionalProperties: false });
  if (Value.Check(exact, input)) return success(input as Output);
  const issues = [...Value.Errors(exact, input)]
    .map((issue) => `${issue.path || "input"}: ${issue.message}`)
    .join("; ");
  return failure(
    new ToolInputValidationError({
      message: `Invalid ${label} input: ${issues}`,
    }),
  );
};

export const decodeThemeStageInput = (input: unknown) =>
  decodeExact<ThemeStageInput>(ThemeStageInputContract, "theme stage", input);
export const decodeContentStageInput = (input: unknown) => {
  const operation =
    typeof input === "object" && input !== null
      ? (input as Readonly<Record<string, unknown>>).operation
      : undefined;
  const decoded = decodeDiscriminated<ContentOperation>(
    ContentOperationContract,
    "kind",
    operation,
  );
  if (decoded._tag === "Failure") return decoded;
  if (
    decoded.value.kind === "replayDraft" &&
    typeof input === "object" &&
    input !== null &&
    "draftId" in input
  ) {
    return failure(
      new ToolInputValidationError({
        message:
          "kind replayDraft must omit draftId because replay creates and returns a new open SiteDraft.",
      }),
    );
  }
  if (decoded.value.kind === "retireCanonical" && decoded.value.expectedRevision < 1) {
    return failure(
      new ToolInputValidationError({
        message: "kind retireCanonical requires expectedRevision to be at least 1.",
      }),
    );
  }
  return decodeExact<ContentStageInput>(ContentStageInputContract, "content stage", {
    ...(input as Readonly<Record<string, unknown>>),
    operation: decoded.value,
  });
};
export const decodeSiteCommitInput = (input: unknown) =>
  decodeExact<SiteCommitInput>(SiteCommitInputContract, "site commit", input);

export const CONTENT_PROMPT_GUIDELINES =
  "Begin with zeroy_inspect resource sites, then inspect the selected site and zcssContract. Inspect the active styleSurface before editing an existing theme. Stage zcss.design.json, manifest-declared custom CSS, templates, and typed content operations into one remote SiteDraft; generated ZCSS paths are compiler-owned and never writable. Inspect the Draft styleSurface and candidate ThemeSchema before commit. For an unmanaged post, inspect content existing-post with draftId and schemaId to get its exact candidate FieldProjection. If staging reports zeroy_site_draft_base_changed, call replayDraft with sourceDraftId and no draftId; it either returns one new open Draft with the complete operation log or a structured conflict without changing either release. Inspect the proof diagnostics, then call zeroy_site_commit with the expected base release and run externalCheck. Never write local files, bypass the connector, or treat staging as live publication.";

export type JsonRecord = Readonly<Record<string, unknown>>;
