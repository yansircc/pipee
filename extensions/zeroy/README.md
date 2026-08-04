# zeroY Runtime Connector

zeroY lets a Pi Agent build a remote WordPress site through a local, Git-backed SiteCheckout. WordPress owns the canonical business facts; one immutable SiteCommit owns the exact Theme, SiteLogic, content, taxonomy, and locale source selected for a release.

```text
local SiteCheckout
→ Blob / Tree
→ SiteCommit
→ CAS DraftRef
→ immutable BuildResult
→ commit/build-bound VerificationProof
→ private PreviewRelease
→ administrator Publish
→ activeSiteReleaseId
```

The extension exposes exactly three zeroY tools:

- `zeroy_inspect` reads bounded operational projections: sites, refs, commit history/diff, release history, proof summaries, integrity, and external checks. Authoring contracts exist only inside the checkout's derived `.zeroy/` projection.
- `zeroy_checkout` materializes the active release or a DraftRef beneath the Pi working directory and initializes a local Git baseline.
- `zeroy_push` computes objects, uploads only missing bytes, moves the DraftRef with CAS, and creates a private PreviewRelease for every renderable commit. It never activates the public site.

File bytes never enter a zeroY tool argument or result. The Agent edits the returned local checkout with ordinary local file tools. Transport IDs, object hashes, revision chains, retries, browser evidence, and public activation remain extension-owned. Only an administrator may publish a proof-ready PreviewRelease.

## Checkout layout

```text
site.json
artifacts/theme/
artifacts/site-logic/
content/posts/<collection-id>/<ref>.json
content/terms/<taxonomy>/<ref>.json
content/site-copy.json
locales/<locale>/posts/<collection-id>/<ref>.json
locales/<locale>/terms/<taxonomy>/<ref>.json
locales/<locale>/site-copy.json
media/
```

`site.json` owns the workspace format, locales, and collection mapping. Paths own document kind, collection/taxonomy, ref, and locale. Document bodies contain only natural business content; WordPress IDs, field IDs, source hashes, revisions, and LocaleOverlay envelopes are compiler details. Deleting a managed canonical or locale document expresses retirement or unpublish in the next release.

The descriptor and unresolved push envelope live under `.zeroy/` and are extension-owned. A pending envelope freezes the complete SiteCommit, so retry after a lost response replays the same command and identity.

## Workflow

1. Inspect `sites`, then checkout the active release or a DraftRef.
2. Checkout `active-release`, or resume a named `refs/drafts/...` ref.
3. Start at `.zeroy/README.md`, `.zeroy/brief.json`, and `.zeroy/review.json`; Brief is administrator-owned intent and Review is the current evidence-backed repair projection.
4. Edit ordinary files and Push every coherent repair slice. Each Push stores an immutable Commit, refreshes `.zeroy/` atomically, and creates an administrator-only PreviewRelease when the Commit is renderable.
5. After each Push inspect `review`. Repair the current bounded gaps until the exact private PreviewRelease is proof-ready.
6. Finish with `current`, `review`, `integrity`, and `proof`. Do not attempt public publication.

Push never activates the public site. An administrator publishes only when Brief, Commit, PreviewRelease, Proof, and the active release CAS bind the same exact version.

## Theme, SiteLogic, and localization

Theme is read-only presentation. SiteLogic owns declared effects and additive storage migrations. One request pins one SiteRelease, so runtime code cannot mix artifact or content versions.

ThemeSchema localization policy maps every canonical field to exactly one rule. Locale overlays retain source hashes, so a canonical change stales only affected translated fields. Repeater or flexible-content rows that are translated independently require stable item keys; position is not identity.

ZCSS and Theme Units are deterministic checkout compilers. The Agent edits source documents; generated paths are compiler-owned and are verified against fresh compilation before release.

## Storage and recovery

The Connector stores immutable blobs, trees, commits, BuildResults, proofs, releases, and idempotent push receipts. DraftRefs are recovery pointers, not runtime selection pointers. `activeSiteReleaseId` is the sole owner of the live version.

All collection inspection is paginated and byte-bounded. Reachability GC treats refs, releases, proofs, recent receipts, and explicit pins as roots and refuses deletion when canonical reachability is corrupt.

The hard cut has no SiteDraft reader, writer, route, tool alias, migration shim, legacy SiteTree reader, or synchronization path. Development/demo data is converted out of band; the production runtime accepts only SiteTree v2 and BuildResult-bound releases.

## Verification

```bash
pnpm --filter @yansircc/pi-zeroy run repo:verify
pnpm --filter @yansircc/pi-zeroy run pi:verify
pnpm --filter @yansircc/pi-zeroy run acceptance:headless
pnpm verify
git diff --check
```

`acceptance:headless` requires `ZEROY_SITES`, `ZEROY_ACCEPTANCE_SITE_ID`, and `ZEROY_ACCEPTANCE_MODEL`. It gives Pi the three zeroY tools plus ordinary local file tools, then verifies checkout recovery, local editing, repeated private Pushes, Review convergence, proof readiness, and that Agent work did not publish the public site.
