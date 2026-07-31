# zeroY Runtime Connector

zeroY lets a Pi Agent author a complete site in one local Git workspace. The workspace contains a read-only `theme/` presentation program and a `site-logic/` business program. WordPress and ACF remain the canonical source for business facts; language presentation is derived from the active ThemeSchema policy and immutable LocaleOverlay values.

```text
WordPress / ACF canonical facts
× ThemeSchema LocalizationPolicy
× LocaleOverlay for a target locale
→ resolved theme projection
```

The Connector has five agent tools: `zeroy_inspect`, `zeroy_site_checkout`, `zeroy_site_verify`, `zeroy_site_push`, and `zeroy_content_apply`.

## Translation workflow

1. Inspect `sites`, then `site` and `schema`.
2. Create or adopt a canonical WordPress post.
3. Inspect `translationJob` with `{ subject: { kind: "post", id }, locale: "en" }`.
4. Call `writeTranslationDraft` with the returned `jobToken`, only the returned writable fields, and its `expectedRevision`.
5. Open the receipt `previewUrl`.
6. Call `publishTranslation` with the returned revision.

`unpublishTranslation` is the inverse public-route operation: it removes only the published pointer and retains the immutable Overlay history and any draft.

The provider-visible tool schema explicitly lists `translationJob`, `writeTranslationDraft`, `publishTranslation`, and `unpublishTranslation`. A normal translation never needs raw ACF, source hashes, or `inherit` decisions.

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

## Site release

`zeroy_site_checkout` creates a local workspace from the active release. Commit local changes, use `zeroy_site_verify` for the local Git boundary, then `zeroy_site_push` builds both immutable Artifacts from the same committed `HEAD`.

```text
ThemeArtifact × SiteLogicArtifact × exact VerificationProof
→ SiteRelease
→ activeSiteReleaseId
```

The Connector verifies static boundaries before it ever loads a candidate, then runs representative front page, singular, archive/taxonomy, search, pagination and 404 requests where current site facts make them available. It pins one SiteRelease for the entire front-end request and never loads Agent Theme or SiteLogic code on `/wp-json/zeroy/*`. Theme may render and read; it cannot own persistence, migration, background work, Connector routes, request-time file writes, or inferred WordPress permalinks. SiteLogic owns declared business capabilities, state and additive storage migrations. Its capability port validates input/output, authorization and observed database effects.

The seed SiteLogic demonstrates the boundary with `rfq.submit@1` (owned RFQ persistence) and `product-selection.evaluate@1` (pure selection rules). They are ordinary Artifact modules, not Connector identities or runtime plugins.

LocaleOverlay is the only locale document protocol. Per-leaf inherit decisions, ThemeCopy, file-by-file theme mutation, ThemeDeployment and their runtime paths are retired. The hard-cut migration materializes a new SiteRelease before it removes legacy deployment tables; no old deployment endpoint, tool alias, reader, writer, or fallback remains.

## Verification

```bash
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
ZEROY_LOCALWP_PORT=10003 pnpm --filter @yansircc/pi-zeroy run acceptance:site-release
```

`acceptance:site-release` is for a disposable LocalWP site. It syncs the Connector, exercises candidate runtime verification, Theme boundary rejection, SiteLogic fatal recovery, capability migration/action execution, concurrent activation CAS, and stale-proof rejection.
