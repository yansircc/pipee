# zeroY Runtime Connector

`@yansircc/pi-zeroy` lets a Pipee/Pi Agent operate independent WordPress
sites through one stable runtime plugin. It is not a Builder or a WordPress
admin replacement: the Agent writes the active theme and uses typed ports for
canonical objects and localized documents. The package-provided WebSurface is
read-only.

```text
Pipee / Pi Agent
  ├─ zeroy_inspect        read Connector facts and external checks
  ├─ zeroy_theme_apply    hash-preconditioned active-theme file writes
  └─ zeroy_content_apply  SiteConfig, canonical objects and locale pointers
           ↓
zeroY Runtime Connector (WordPress)
  ├─ SiteConfig                 language configuration
  ├─ ThemeSchema                localized node contract
  ├─ WordPress / ACF            canonical business facts
  └─ LocaleStore                immutable versions and publish pointers
```

## What the runtime owns

- Site-local `defaultLocale` and enabled locales, each with an explicit URL
  prefix and CAS revision.
- `zeroy.schema.json` is the Agent-authored ThemeSchema candidate. A successful
  Connector apply transaction reconciles every LocaleHead, reserves declared
  collection routes and atomically replaces one active database snapshot.
  Readers never inspect the candidate file directly.
- WordPress post fields and ACF values are canonical business facts. zeroY
  LocaleHeads are a separate, explicit localized presentation fact; they never
  silently copy, translate, or overwrite ACF values.
- One canonical WordPress object per localized business page, then a separate
  LocaleHead and immutable LocaleVersion for each language. ThemeCopy uses the
  same version-pointer algebra but has no WordPress post or route.
- Locale-first object and CollectionRoutes, archive/search projections,
  canonical and `hreflang`.
  Missing, draft, disabled, unpublished or schema-mismatched locales are 404;
  there is no fallback language.
- ThemeSchema activation is a hard-cut transaction. Lossless migrations create
  new immutable versions and switch the active snapshot in the same commit. If
  any head or route is incompatible, the transaction rolls back and the old
  snapshot remains live; the apply receipt lists every affected head. Directly
  editing the candidate file only produces `schema_candidate_not_active`.
- Active-theme regular files only. Each write requires the hash that was read;
  a multi-file request reports its actual per-file partial outcome.

The runtime plugin is stable and outside the Agent's write root. The Agent can
read and write only ordinary files under the currently active theme.

## Installation

1. Copy `wordpress-plugin/` to the site's `wp-content/plugins/` and activate
   **zeroY Runtime Connector**.
2. Install or activate a theme whose root contains `zeroy.schema.json` and the
   templates named by it. `mvp-theme/` is a runnable local reference theme.
3. Read the Connector identity and key from the target site. Do not place the
   key in a committed file.

```sh
locwp wp 10013 -- option get zeroy_runtime_site_id
locwp wp 10013 -- option get zeroy_runtime_connection_key
```

4. Give the Pi process one `ZEROY_SITES` JSON value. The handshake site ID is
   checked on every session start; a mismatch fails the connection rather than
   silently targeting another site.

```sh
export ZEROY_SITES='[
  {
    "siteId": "the-connector-site-id",
    "label": "Local zeroY demo",
    "endpoint": "http://localhost:10013",
    "connectionKey": "the-connector-key"
  }
]'
```

The Agent begins with `zeroy_inspect { "resource": "sites" }`; it receives
only the configured `siteId`, label and endpoint, never a connection key.

Run a local built extension with Pi:

```sh
pnpm --filter @yansircc/pi-zeroy run pi:build
pi --extension ./extensions/zeroy/dist/pi/extension.js
```

After the package is installed in Pipee, open its **zeroY Sites** private page
to inspect the same read-only projection. All mutations remain in the Agent
conversation. Optional PageSpeed checks are extension-owned; set
`ZEROY_PAGESPEED_API_KEY` only when that check is wanted.

## ThemeSchema reference

```json
{
  "contract": "zeroy/theme-schema@1",
  "themeCopy": {
    "nodes": {
      "nav.home": { "kind": "text", "required": true, "searchable": false },
      "cta.quote": { "kind": "text", "required": true, "searchable": false },
      "archive.case_studies": { "kind": "text", "required": false, "searchable": false }
    }
  },
  "collections": {
    "case-studies": {
      "kind": "post-archive",
      "label": "Case studies",
      "route": "case-studies",
      "template": "collection-case-studies.php",
      "schemaId": "case-study",
      "titleNode": "archive.case_studies"
    }
  },
  "schemas": {
    "case-study": {
      "label": "Case study",
      "template": "single-case-study.php",
      "canonicalPostTypes": ["case_study"],
      "titleNode": "title",
      "nodes": {
        "title": { "kind": "text", "required": true, "searchable": true },
        "summary": { "kind": "rich-text", "required": true, "searchable": true },
        "process.steps.*.label": { "kind": "text", "required": true, "searchable": false }
      }
    }
  }
}
```

CollectionRoutes are available for every enabled locale even when empty. The
Connector owns locale prefixes, permanent route reservations, canonical and
alternate links; the template owns only markup:

```php
$collection = zeroy_collection_context();
$page = zeroy_collection_items(['url', '/post/title', '/post/excerpt']);
```

Relationship fields stay as canonical IDs. Resolve cards explicitly and in a
batch so ordinary content reads never hide I/O or recursive hydration:

```php
$related = zeroy_locale_entities(
    $content['acf']['related_machines'],
    zeroy_current_locale(),
    ['url', '/post/title', '/acf/machine_capacity']
);
```

The PHP template reads one resolved projection through the explicit identity
`objectId × locale × schemaId`:

```php
$content = zeroy_locale_content($post->ID, zeroy_current_locale(), 'case-study');
echo esc_html($content['post']['title']);
echo wp_kses_post($content['nodes']['summary']);
echo esc_html($content['acf']['machine_capacity']);
```

Global shell copy uses its own explicit helper, not PHP string tables or ACF
prefix conventions:

```php
$copy = zeroy_theme_copy_document(zeroy_current_locale());
echo esc_html($copy['nav.home']);
```

`zeroy_inspect { resource: "schema" }` returns the complete node-language
capability list. Invalid schemas return every structured violation at once,
including the schema/node/field, expected constraint and actual type.

`titleNode` is optional. When declared, it is the localized title used by the
search projection; otherwise that projection uses the canonical WordPress post
title. There is no magic `_title` field convention.

## Existing WordPress and ACF sites

Existing content is not invisible, and it is not auto-migrated. The Agent uses
one explicit identity-only flow:

```text
adoptionCandidates → existingPost → adoptCanonical(expectedSourceHash)
```

`adoptionCandidates` lists unmanaged posts and safe summaries. `existingPost`
returns one post's canonical WordPress fields, current ACF runtime values (the
same field-name shape PHP receives from `get_fields()`), and a `sourceHash`.
For select, radio, checkbox and button-group definitions, the ACF projection
also exposes stable choice `value` plus its admin `label`. `adoptCanonical`
succeeds only while that hash still matches; it attaches a ThemeSchema and
zeroY canonical revision, without copying or translating existing data.

WordPress post fields and raw ACF values remain canonical business facts. For
each canonical object, `contentTree` automatically projects the post fields and
every leaf of every currently applicable ACF group. A LocaleVersion stores one
explicit decision for every projected path:

```json
{
  "contract": "zeroy/locale-version@2",
  "nodes": {},
  "decisions": {
    "/acf/machine_capacity": { "mode": "inherit", "sourceHash": "..." },
    "/post/title": {
      "mode": "override",
      "sourceHash": "...",
      "value": "本地化标题"
    }
  }
}
```

No hand-authored translation schema selects ACF fields. Missing decisions are
unresolved; a decision whose `sourceHash` no longer matches WordPress/ACF is
stale. Either condition blocks publishing. Overrides affect only the locale
projection and never write back to canonical WordPress or ACF storage.

## Routes and mutation receipts

`/` is the explicit FrontPage route. It is stored as the unique empty route
only after the caller supplied `/`; it resolves to the default locale's site
root and to each other locale's prefix root. All other routes are non-empty,
path-safe strings, including ordinary WordPress-style underscore segments.

After a default-locale document is published, its native WordPress permalink
301 redirects to the zeroY locale URL. A reserved zeroY path remains owned by
zeroY; an explicit native object URL such as `?page_id=42` still redirects even
when plain WordPress permalinks make its path `/`.

Use `commit` to write and publish a page LocaleVersion atomically. Use
`writeDraft → draftPreviewUrl → publish` when a human or Agent must review the
rendered draft first. `draftPreviewUrl` is signed, uncacheable and `noindex`;
it renders only the current draft.

`writeDraft`, `commit`, `publish`, `unpublish`, and all ThemeCopy mutations
return a compact receipt (scope, locale, revision, version IDs, state, route,
URL, and draft preview URL where applicable). They never echo documents. Use
`patchThemeCopyDraft` for a small ThemeCopy delta; it materializes a complete
immutable version server-side. Read `contentTree`, `localeContent`, or
`themeCopy` when the full source tree or version envelope is actually needed.
ThemeCopy versions use `zeroy/theme-copy-version@2` with a `nodes` object and
no content decisions.

## Read-only WebSurface

For each configured site it shows the Connector/runtime handshake, ThemeSchema
hashes, enabled locales, schema and ACF structures, canonical inventory and
locale states, Connector integrity, and the most recent external check.
External checks fetch published URLs and report status/final URL, title,
description, `h1`, canonical, `hreflang`, and up to 20 same-origin links.

It never owns a second copy of site state and has no builder, code editor,
translation form or mutation controls.

## Verification

```sh
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
```

`pi:verify` includes a deterministic real-Pi transport gate. It sends the built
extension through Pi's Anthropic Messages adapter to a local fake provider and
asserts the exact `input_schema` received by that provider.

The destructive real-model headless acceptance is intentionally separate from
normal CI. It creates a CSS file and a published bilingual page on the selected
disposable site:

```sh
export ZEROY_ACCEPTANCE_SITE_ID='the-connector-site-id'
export ZEROY_ACCEPTANCE_MODEL='anthropic/your-model'
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
```

It disables built-in tools, implicit extensions, skills and context files, then
audits the Pi session JSONL for probes, validation failures, unknown actions,
revision chaining, Connector-only readback and final HTTP 200 responses.

The destructive LocalWP proof requires active ACF and a disposable runtime
site. It validates revision conflicts, transactional schema activation,
staged-candidate reader continuity, CollectionRoute/taxonomy tombstones,
batch entity URLs, default-language locking, hash guarded theme writes,
unresolved-publish rejection, stale-source detection, ACF projection and
Connector integrity.

```sh
locwp wp 10013 -- plugin activate advanced-custom-fields-pro
locwp wp 10013 -- eval-file "$PWD/extensions/zeroy/test-suite/local-runtime-acceptance.php"
```

## V1 boundary

This version intentionally permits direct writes to a live active theme.
ThemeSchema activation is staged and transactional, but arbitrary PHP/CSS/JS
files in one `theme_apply` request are still independent hash-guarded writes,
not a versioned theme release. It has no approval, whole-theme rollback, full
production authorization model, arbitrary command execution, direct SQL,
cross-site fleet, or manual WordPress translation UI.

When templates and assets must switch atomically with ThemeSchema, the active
theme itself must move to immutable release directories plus one release
pointer. Do not simulate that guarantee with file-ordering or fallback reads.

### Removing pre-CollectionRoute stopgaps

When migrating an existing theme, delete its archive rewrite rules, locale
query variable, manual language-URL builder, archive canonical/hreflang hooks,
and route-to-post-type configuration table. Replace `have_posts()`/manual
`zeroy_locale_content()` loops with `zeroy_collection_context()` and
`zeroy_collection_items()`. Historic Connector reservations remain 404
tombstones; theme rewrites never regain those paths.
