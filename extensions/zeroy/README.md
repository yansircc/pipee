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
  ├─ WordPress / ACF            canonical and shared facts
  └─ LocaleStore                immutable versions and publish pointers
```

## What the runtime owns

- Site-local `defaultLocale` and enabled locales, each with an explicit URL
  prefix and CAS revision.
- `zeroy.schema.json` from the active theme. It declares localized `text` and
  `rich-text` node IDs; it does not duplicate ACF fields or language config.
- One canonical WordPress object per business page, then a separate LocaleHead
  and immutable LocaleVersion for each language.
- Locale-first routes, archive/search projections, canonical and `hreflang`.
  Missing, draft, disabled, unpublished or schema-mismatched locales are 404;
  there is no fallback language.
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
  "schemas": {
    "case-study": {
      "label": "Case study",
      "template": "single-case-study.php",
      "canonicalPostTypes": ["case_study"],
      "nodes": {
        "title": { "kind": "text", "required": true, "searchable": true },
        "summary": { "kind": "rich-text", "required": true, "searchable": true },
        "process.steps.*.label": { "kind": "text", "required": true, "searchable": false }
      }
    }
  }
}
```

The PHP template reads localized facts through the explicit identity
`objectId × locale × schemaId`:

```php
$document = zeroy_locale_document($post->ID, zeroy_current_locale(), 'case-study');
echo esc_html($document['title']);
echo wp_kses_post($document['summary']);
```

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
site. It validates revision conflicts, default-language locking, hash guarded
theme writes, real partial batch results, schema-hash 404/recovery, unpublish
and disabled-language tombstones, locale-first archive/search, ACF projection,
and Connector integrity.

```sh
locwp wp 10013 -- plugin activate advanced-custom-fields-pro
locwp wp 10013 -- eval-file "$PWD/extensions/zeroy/test-suite/local-runtime-acceptance.php"
```

## V1 boundary

This version intentionally permits direct writes to a live active theme. It
has no staging, approval, rollback, multi-file transaction, full production
authorization model, arbitrary PHP execution, direct SQL, cross-site fleet,
or manual WordPress translation UI. The Connector itself, WordPress core,
other plugins and inactive themes are outside the writable boundary.

When a product needs all-or-nothing releases, unattended customer writes or
multi-tenant access, this must move to a staging/release-pointer model rather
than grow conditional safety branches in the direct-write port.
