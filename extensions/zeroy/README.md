# zeroY Runtime Connector

zeroY lets a Pi Agent author a complete remote WordPress site through one disposable SiteDraft. Theme files, schema, canonical content and locale overlays are staged remotely; only a verified SiteRelease becomes active. WordPress and ACF remain the canonical source for business facts; language presentation is derived from the active ThemeSchema policy and immutable LocaleOverlay values.

```text
WordPress / ACF canonical facts
× ThemeSchema LocalizationPolicy
× LocaleOverlay for a target locale
→ resolved theme projection
```

The Connector has four agent tools: `zeroy_inspect`, `zeroy_theme_stage`, `zeroy_content_stage`, and `zeroy_site_commit`.

## Translation workflow

1. Inspect `sites`, then the selected `site`, `release`, and active `themeFiles`.
2. Stage remote Theme and typed content operations into one SiteDraft. Omitting `draftId` atomically creates the Draft and appends that first operation; a failed first operation leaves no empty Draft behind.
3. After staging or changing a ThemeSchema, inspect `resource: "draft"`. Its candidate ThemeContract, ThemeSchema, ACF projection, and virtual theme manifest are the exact contract that commit will compile. This inspection is read-only: it neither writes artifacts nor creates a release.
4. For an unmanaged WordPress post, inspect `content.kind: "existing-post"` with that `draftId` and candidate `schemaId`. The returned FieldProjection is the exact candidate field identity, item-key, source-hash, value-shape, and localization-policy input for adoption and translation.
5. Inspect `content.kind: "translation"` for an adopted/published subject and stage its locale draft operation. Reinspect the Draft after meaningful changes.
6. Commit once with the Draft's expected base release. If CandidateProof blocks it, inspect `resource: "proof"`, repair the Draft, and commit again. Nothing is live before this step.

`unpublishTranslation` is the inverse public-route operation: it removes only the published pointer and retains the immutable Overlay history and any draft.

The provider-visible tool schema explicitly lists the content inspection modes and typed `writeTranslationDraft`, `publishTranslation`, and `unpublishTranslation` operations. A normal translation never needs raw ACF, source hashes, or `inherit` decisions.

## ThemeSchema

Every post schema declares a `zeroy/localization-policy@1`:

```json
{
  "localization": {
    "contract": "zeroy/localization-policy@1",
    "rules": [
      {
        "fieldPattern": "/post/title",
        "mode": "translated",
        "required": true,
        "contextWeight": "primary"
      },
      {
        "fieldPattern": "/post/content",
        "mode": "translated",
        "required": true,
        "contextWeight": "primary"
      },
      {
        "fieldPattern": "/acf/**",
        "mode": "overridable",
        "required": false,
        "contextWeight": "supporting"
      }
    ],
    "repeaterItemKeys": { "/acf/field_specs": "field_spec_code" }
  }
}
```

Each canonical field must match exactly one rule. `shared` and `derived` values cannot be written to an Overlay. Existing `overridable` values and all `translated` values retain their source hash, so only the affected field becomes stale when canonical content changes.

Repeater and flexible-content fields that are localizable per row must declare a stable ACF item key. Position is never an identity.

Every post schema also declares one `routeKind`: `front-page`, `document`, or `singular`. Each canonical object owns its explicit route; a schema never silently supplies one. Exactly one `front-page` schema may own `/`; every `document` and `singular` route must be non-root. Search, archive, taxonomy, and 404 are the remaining explicit RouteSpec kinds.

The default locale must have exactly one committed `front-page` canonical at `/`. A candidate that omits it cannot activate, even if every other route renders.

## Site release

`zeroy_theme_stage` and `zeroy_content_stage` append remote operations to one SiteDraft. Theme staging is the only Agent file-write operation; connector-owned SiteLogic participates in CandidateProof but is not an Agent-editable file tree. `zeroy_site_commit` is the only operation that can activate a SiteRelease after CandidateProof succeeds. `zeroy_inspect { resource: "draft" }` compiles an ephemeral candidate from the same ordered operation log that commit uses, so it is the contract-discovery boundary for staged schemas; it is not a preview cache or second mutable store. A stage receipt's `lastOperation.nextRevision` is the exact `expectedRevision` for the same subject's next mutation; only a new locale begins at `0`. Draft receipts expose compact operation summaries, affected subjects/artifacts, and staged file hashes—not staged source or document bytes. Candidate releases and their proofs are readable only by the Pi session that owns the source Draft; history contains only activated or superseded Releases. `zeroy_inspect { resource: "proof" }` is the explicit path for complete CandidateProof evidence. All are read-only projections of the same Draft and proof facts.

```text
ThemeArtifact × SiteLogicArtifact × exact VerificationProof
→ SiteRelease
→ activeSiteReleaseId
```

The Connector verifies static boundaries before it ever loads a candidate, then runs representative front page, singular, archive/taxonomy, search, pagination and 404 requests where current site facts make them available. It pins one SiteRelease for the entire front-end request and never loads Agent Theme or SiteLogic code on `/wp-json/zeroy/*`. Theme may render and read; it cannot own persistence, migration, background work, Connector routes, request-time file writes, or inferred WordPress permalinks. SiteLogic owns declared business capabilities, state and additive storage migrations. Its capability port validates input/output, authorization and observed database effects.

On a site with no active release, `themeFiles` returns an explicit empty bootstrap projection. `zeroy_inspect { resource: "site" }` also returns `themeAuthoring`: the generic ThemeSchema, RouteSpec, localization, theme-file, and `zeroy_theme_context()` grammar required to author the first release. The first theme stage must provide the complete ThemeArtifact; its Draft has `baseReleaseId: null`, and the first commit must return that exact `null` as `expectedBaseReleaseId`.

LocaleOverlay is the only locale document protocol. Per-leaf inherit decisions, ThemeCopy, file-by-file theme mutation, ThemeDeployment and their runtime paths are retired. No old deployment endpoint, tool alias, reader, writer, or request-time fallback remains. A single upgrade-time conversion writer turns an already-active pre-SiteDraft release into a normal immutable Snapshot release, then deletes the old Release/proof rows; it is not a compatibility API or reader.

## Verification

```bash
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
ZEROY_REMOTE_ONLY_LOCALWP_PORT=10030 pnpm --filter @yansircc/pi-zeroy run acceptance:remote-only
ZEROY_BOOTSTRAP_LOCALWP_PORT=10022 pnpm --filter @yansircc/pi-zeroy run acceptance:bootstrap
ZEROY_LOCALWP_PORT=10003 pnpm --filter @yansircc/pi-zeroy run acceptance:site-release
ZEROY_UPGRADE_LOCALWP_PORT=10070 pnpm --filter @yansircc/pi-zeroy run acceptance:upgrade
```

`acceptance:bootstrap` and `acceptance:site-release` both require a fresh disposable LocalWP site. The SiteRelease runner checks that zeroY has no prior release, proof, Draft, or migration ledger before it starts; this prevents a reused site's storage epoch from masquerading as a product regression. It syncs the Connector, exercises candidate runtime verification, Theme boundary rejection, SiteLogic fatal recovery, capability migration/action execution, concurrent activation CAS, and stale-proof rejection.

`acceptance:remote-only` is a deterministic Pi transport/host acceptance, not a claim about a hosted model's reasoning quality. It first creates the production npm archive, extracts it into a temporary directory, and deploys both the Pi extension and WordPress connector from that one archive. Pi then starts in an empty temporary cwd with built-in tools, ambient extensions, skills, prompts, context files, and themes disabled; the only callable surface is the four zeroY tools. A local fake Anthropic provider drives the exact remote calls against a fresh LocalWP Connector and the resulting Pi session JSONL proves the single Draft → proof → active SiteRelease loop without a filesystem, database, SSH, or source-code tool.

`acceptance:upgrade` begins with a real prior SiteRelease table shape, then starts a fresh WordPress process with the current Connector. It proves that exact columns are added without rebuilding unrelated tables, an old active Release becomes one proof-backed Snapshot Release, and no old Release/proof row remains exposed.
