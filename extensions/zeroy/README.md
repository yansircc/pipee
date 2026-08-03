# zeroY Runtime Connector

zeroY lets a Pi Agent build a remote WordPress site through a local, Git-backed SiteCheckout. WordPress owns the canonical business facts; one immutable SiteCommit owns the exact Theme, SiteLogic, content, taxonomy, and locale source selected for a release.

```text
local SiteCheckout
→ Blob / Tree
→ SiteCommit
→ CAS DraftRef
→ commit-bound VerificationProof
→ SiteRelease
→ activeSiteReleaseId
```

The extension exposes exactly three zeroY tools:

- `zeroy_inspect` reads bounded canonical projections such as sites, refs, commit history/diff, schema, inventory, ACF, proof diagnostics, integrity, and external checks.
- `zeroy_checkout` materializes the active release or a DraftRef beneath the Pi working directory and initializes a local Git baseline.
- `zeroy_push` computes objects, uploads only missing bytes, moves the DraftRef with CAS, and optionally verifies and activates the exact commit.

File bytes never enter a zeroY tool argument or result. The Agent edits the returned local checkout with ordinary local file tools. Transport IDs, object hashes, revision chains, retries, browser evidence, and activation remain extension-owned.

## Checkout layout

```text
site.json
artifacts/theme/
artifacts/site-logic/
content/posts/*.json
content/terms/*.json
content/site-copy.json
translations/<locale>/posts/*.json
translations/<locale>/terms/*.json
translations/<locale>/site-copy.json
media/
```

`site.json` owns site configuration. `content/site-copy.json` is the only canonical SiteCopy owner. Post and term filenames are stable refs; WordPress IDs are materialization details. Deleting a managed content or translation document expresses retirement or unpublish in the next release.

The descriptor and unresolved push envelope live under `.zeroy/` and are extension-owned. A pending envelope freezes the complete SiteCommit, so retry after a lost response replays the same command and identity.

## Workflow

1. Inspect `sites`, then the selected site's refs, schema, inventory, ACF, and authoring contracts.
2. Checkout `active-release`, or resume a named `refs/drafts/...` ref.
3. Edit only the returned directory. Use `git status` and `git diff` locally.
4. Push `checkpoint` at recovery milestones.
5. Push `release`. If proof blocks, inspect `proof` with `repairGroups` or paginated `failures`, repair the same checkout, and push again.
6. Finish with `integrity` and `externalCheck`.

A checkpoint never activates the public site. A release only activates when its Proof binds the same SiteCommit and the active release CAS still matches its base.

## Theme, SiteLogic, and localization

Theme is read-only presentation. SiteLogic owns declared effects and additive storage migrations. One request pins one SiteRelease, so runtime code cannot mix artifact or content versions.

ThemeSchema localization policy maps every canonical field to exactly one rule. Locale overlays retain source hashes, so a canonical change stales only affected translated fields. Repeater or flexible-content rows that are translated independently require stable item keys; position is not identity.

ZCSS and Theme Units are deterministic checkout compilers. The Agent edits source documents; generated paths are compiler-owned and are verified against fresh compilation before release.

## Storage and recovery

The Connector stores immutable blobs, trees, commits, proofs, releases, and idempotent push receipts. DraftRefs are recovery pointers, not runtime selection pointers. `activeSiteReleaseId` is the sole owner of the live version.

All collection inspection is paginated and byte-bounded. Reachability GC treats refs, releases, proofs, recent receipts, and explicit pins as roots and refuses deletion when canonical reachability is corrupt.

The hard cut has no SiteDraft reader, writer, route, tool alias, migration shim, or synchronization path. Upgrade converts the one active artifact-backed release in place to a SiteSnapshot, seeds its first SiteCommit, binds a proof, and deletes unreadable legacy history.

## Verification

```bash
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
pnpm verify
git diff --check
```

`acceptance:headless` requires `ZEROY_SITES`, `ZEROY_ACCEPTANCE_SITE_ID`, and `ZEROY_ACCEPTANCE_MODEL`. It gives Pi the three zeroY tools plus ordinary local file tools, then verifies checkout, local editing, release push, integrity, and external page evidence from the persisted Pi session ledger.
