# FAQ

## Why atomic tools with runtime profiles?

Weak models are more reliable when each tool has one small parameter schema, but loading all 25 atomic schemas on every turn wastes context. Pi therefore starts with six core operations plus `chrome_enable`. Advanced operations are registered but inactive; enabling `tabs`, `page`, `network`, `capture`, or `interaction` makes that profile available immediately. The operation descriptor remains the single source for atomic registration, profile membership, public schema, wire projection, result contract, and deadline.

## Does it use my active tab?

Not implicitly. Page/input calls without a target allocate an automation tab when the current Pi
session owns none or use it when the session owns exactly one. If the session owns several tabs,
the call fails as ambiguous and returns their summaries; pass one exact id. Pi never selects from
Chrome's active tab or a mutable last-used pointer. To use an existing user tab, pass one tagged
target by id, URL substring, or title substring.

That selector is resolved exactly once at command entry. The operation keeps the resolved tab id;
it cannot jump to a different tab because a URL, title, or active-tab state changes mid-command.

Owned targets are tabs in an already-open normal window of the connector selected for the run.
They therefore use that profile's cookies and login state. Normal automation does not launch
Chrome, create a window, or create a user-data directory. On macOS, the separate `/chrome onboard`
setup command may ask the OS to open ordinary Google Chrome at `chrome://extensions`.

`vp run smoke:connector` is intentionally different: it launches a temporary Chrome-for-Testing
profile against a random fake bridge. Pi Terminal selects its normal connector through
`/chrome onboard`; `pi-web` selects the connector installed beside the page in its current profile.

## Can multiple Pi sessions run concurrently?

Yes. Terminal sessions may share the durable connector, while `pi-web` sessions may use different
profile connectors. Ownership and cleanup are keyed by Pi session. Each session may own at most five
targets in a profile.

The paired profile stores at most 256 durable targets across all sessions. Both quota dimensions are
checked before a tab is created. Normal session cleanup removes its exact set; if abandoned records
fill the profile, `/chrome unpair` performs acknowledged profile-wide cleanup before the profile can
be paired again.

## What does text snapshot return?

`mode: "text"` returns bounded semantic content blocks in document order: headings, paragraphs,
list items, and standalone links. Linked headings carry their href and uid; blocks also carry their
nearest semantic container context. The page runtime owns this classification, and the Pi formatter
only renders it. It does not use Google-specific selectors or claim to identify arbitrary
extension-injected DOM. For a clean observation surface, pair a dedicated signed-in Chrome profile.

Every snapshot mode also returns a compact Action Graph built from Accessibility Tree and DOM interaction evidence. An entry such as `@el-12 textbox "Email" [fill, press]` names a typed live capability: only tools matching one of its issued verbs may consume it. A stale ref, wrong verb, disabled target, or covered click point is rejected before input dispatch; Pi never searches for a replacement by role or accessible name.

Snapshot budgets preserve a shallow context graph. Every omitted action subgraph is represented by
a `FrontierRef`, so the agent can expand the relevant region without loading a page-wide tree or
walking a linear cursor. `chrome_read` provides the parallel content projection for the exact
rendered tab; it returns headings, paragraphs, links, coverage, and content frontiers without
running AX action discovery.

## What happens when wait reaches its deadline?

The deadline is a negative observation, not a browser failure. The result has `satisfied: false`,
elapsed time, current URL/title/readyState, body-text length, and selector match count when
applicable. Typed conditions support `selector`, `urlIncludes`, and `textContains`; `expression`
remains the CDP escape hatch and may have page-defined side effects. A thrown expression can still
be outcome-unknown because it may mutate before throwing.

## Why does pairing identify a profile separately from the extension id?

One auth configuration owns the manifest public key; the build injects it and Node derives the
stable extension id from it. Chrome profiles loading that package still share the extension id, so
each profile generates a separate connector id and secret in `chrome.storage.local`. For Terminal,
only the profile where you enter the `/chrome onboard` token receives commands. For `pi-web`, Chrome
delivers external messaging to the extension in the page's own profile; that instance creates an
expiring live claim for a persistent Pi-session route. Multiple offers are keyed by pairing id.
When a claim expires, the route remains attached but unavailable until the same profile renews it;
it never falls back to the Terminal connector.

To change the Terminal profile, run `/chrome unpair` before `/chrome onboard`. Unpair succeeds only
after the currently bound connector acknowledges profile-wide cleanup; it never silently forgets a
binding when cleanup fails.

Both `/chrome unpair` and `/chrome forget` durably lock the Pi session before binding removal.
Because the session ledger and binding file are separate stores, a hard crash may leave a locked
session with the old binding still present; rerun the explicit command. `/chrome forget` is only for
a permanently lost connector identity and cannot close or prove its old tabs, which remain manual
cleanup orphans.

Pi SDK 0.80.6 updates the in-memory session ledger before a synchronous append can report a disk
failure. `pi-chrome` treats that failure as outcome-unknown and keeps the current process
fail-closed until `/chrome revoke` appends a fresh lock. A hard process crash loses that poison
record; durable certainty requires an acknowledged or transactional append API from Pi.

## Does evaluation work under strict CSP?

Yes. `chrome_evaluate` uses CDP `Runtime.evaluate`; snapshot/inspect inject a packaged MAIN-world script. Neither depends on page-level `eval` or `new Function`.

Evaluation results are always bounded JSON. Values JSON cannot faithfully represent—such as
undefined, bigint, functions, symbols, errors, non-finite numbers, cycles, shared references, and
non-plain objects—are returned as explicit `PiChromeEvaluationMarker` objects. They are not
unwrapped or silently coerced. `awaitPromise: true` (the default) waits within the command deadline;
`false` projects the Promise object itself without waiting.

`evaluate` accepts one JavaScript expression. Pi dispatches that expression once: a syntax or
runtime error is returned as failure and is never retried as a statement body, because doing so
could repeat page side effects.

## Is input trusted?

The atomic input tools use Chrome's debugger input domain for pointer, keyboard, wheel, touch, drag, and file input. Chrome may show its debugger banner. This satisfies normal browser input gates but does not promise that automation is undetectable.

## How do I verify an interaction?

Set `includeSnapshot: true` on `chrome_click`, `chrome_type`, `chrome_fill`, or `chrome_press`.
Every result contains the action receipt separately from verification. Successful verification is
`{ status: "observed", snapshot }`; if a route change makes the post-action snapshot unavailable,
the result is `{ status: "unavailable", reason }` and the action receipt remains authoritative.
Do not replay that action merely because verification was unavailable. A separate screenshot is
available after enabling the `capture` profile and calling `chrome_screenshot`.

Viewport screenshots publish one image artifact. Full-page screenshots publish a tile-set
directory plus `manifest.json`, not a stitched image. Capture is pinned to the selected tab through
CDP and does not activate it or scroll the document. The tagged viewport `path` and full-page
`directory` remain on the Pi side and never enter the browser command. Full-page geometry is
checked against protocol-owned DPR and raster-pixel budgets before Chrome captures the first tile.

## What does `waitUntilLoad` mean?

Navigation is tied to the exact frame, loader, and command generation returned by CDP.
The default waits only for that generation's document commit so SPAs can be observed immediately.
Set `waitUntilLoad: true` only when the task specifically requires the matching load event. A
lifecycle event from an earlier navigation cannot satisfy a later command.
The command's one-shot init script is removed before the debugger session can be reused. If removal
cannot be proved, Pi resets that debugger session; a failed reset quarantines it from later commands
until cleanup succeeds.

## Does it work in Chromium browsers other than Chrome?

Chrome 120 is the minimum supported runtime. Other Chromium browsers may work if they provide the
same MV3 and `chrome.debugger` surface. Firefox and WebKit are outside this implementation boundary.

## What happens after an update?

Run `vp run build` when developing locally, then reload `dist/browser-extension` from `chrome://extensions`. The connector identity survives in `chrome.storage.local`, while tab ownership intentionally does not cross an extension reload/update or browser restart. Run `/chrome doctor`; if it reports stale targets, run `/chrome cleanup` and retry the page/input operation. Cleanup deletes stale records without closing or adopting unprovable tabs, and the next implicit operation creates a new target. A changed semantic wire contract produces a new fingerprint and fails closed until the matching extension is loaded; edits only to JSON Schema descriptions/examples do not change it.

The build stages and validates a complete extension before replacement, so prepare or validation
failure does not touch the previous output. If the publish rename fails after backup, restoration is
attempted; restoration failure preserves both errors and the exact backup path. If publication
succeeds but backup cleanup fails, the new output can already be live beside the old backup. The
next build resolves one unambiguous backup and removes stale staging; multiple backups fail closed
for manual review.

## What is the security boundary?

The extension has `tabs`, `tabGroups`, `scripting`, `storage`, `unlimitedStorage`, `alarms`, and `debugger` permissions in the profile where it is installed. Owner, connector, and pairing traffic use separate mutual-HMAC domains. Polling and results carry the public connector identity plus a one-shot HMAC proof derived from its secret; after binding, the secret itself never leaves the extension. The owner credential and pairing token likewise remain off-wire, and every client verifies the bridge proof before sending its actual request. Connector proofs authenticate the fixed extension id, connector id, exact display version, protocol fingerprint, bridge epoch, one-shot nonce, method, path, and body hash. HTTP `Origin` is an additional check when Chrome supplies it, not a credential. Commands and results must pass a bounded JSON/schema gate before queueing or journaling. A hostile process running as the same OS user can still read the owner credential and reach loopback, so use a separate OS account if that threat matters.

## What is out of scope?

Native Chrome/OS dialogs, arbitrary desktop applications, visual CAPTCHA solving, hardware-backed authentication, rich multi-touch gestures, and deterministic DOM inspection across cross-origin frames.
