# zeroY Runtime Connector

zeroY lets a Pi Agent author a WordPress theme as a local Git checkout and deploy it as an immutable ThemeArtifact. WordPress and ACF remain the canonical source for business facts; language presentation is derived from the active ThemeSchema policy and immutable LocaleOverlay values.

```text
WordPress / ACF canonical facts
× ThemeSchema LocalizationPolicy
× LocaleOverlay for a target locale
→ resolved theme projection
```

The Connector has four agent tools: `zeroy_inspect`, `zeroy_theme_checkout`, `zeroy_theme_push`, and `zeroy_content_apply`.

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

## Theme deployment

`zeroy_theme_checkout` creates a local Git checkout from the active Artifact. Commit local changes, then `zeroy_theme_push` uploads the committed `HEAD`, prepares a candidate, previews it, and CAS-activates it. The only mutable live theme fact is `activeDeploymentId`; each front-end request pins one Artifact.

LocaleOverlay is the only locale document protocol. Per-leaf inherit decisions, ThemeCopy, file-by-file theme mutation, and their tables are retired. This hard cut assumes active sites have been migrated before installation; the upgrade removes the retired tables and has no legacy decoder, reader, writer, or fallback path.

## Verification

```bash
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
```
