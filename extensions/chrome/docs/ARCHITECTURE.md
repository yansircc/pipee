# Architecture

The invariant is:

```text
ExtensionPackageId ≠ ProfileConnectorId
DisplayVersion ≠ ProtocolFingerprint
Command → BoundConnectorMailbox → ExactProfile → SessionOwnedTab
ToolCall → WireProjection → ExactTabId → Operation
AX Tree ∪ DOM Evidence → ActionRef(id, role, name, state, verbs)
Snapshot @ref + verb → Matching Atomic Tool → Same Live DOM Node
Budget cut → ContextRef + FrontierRef → Local expansion
queued → executing → durable result/outcome-unknown → acknowledged
```

## Protocol owner

[`src/protocol/operation-contract.ts`](../src/protocol/operation-contract.ts) owns every operation: nested tagged wire call, result contract, deadline kind, atomic tool name, capability profile, prompt description, and tool-only parameter projection. [`src/protocol/schema.ts`](../src/protocol/schema.ts) composes the generated call unions with connector and transport envelopes. Filesystem destinations and the `background` preference exist only in tool calls; the wire projection removes them before routing. Tool registration, profile membership, `chrome_enable`, request decoding, and protocol contracts derive from this descriptor map. Neither runtime owns a second operation or tool list.

[`src/protocol/protocol-fingerprint.ts`](../src/protocol/protocol-fingerprint.ts) canonicalizes the semantic wire/result schema plus bridge/auth configuration and hashes it with SHA-256 in both runtimes. JSON Schema annotations (`description`, `title`, examples, defaults, comments, and similar documentation fields) are removed, and set-like schema members are order-normalized; constraints, deadline kinds, and non-schema bridge/auth values remain significant. Owner handshakes, pairing, and connector polling require that fingerprint exactly. The package version does not decide compatibility, but the exact extension display version is authenticated inside each connector HMAC identity tuple.

[`src/protocol/json-transport.ts`](../src/protocol/json-transport.ts) is the only JSON transport gate. It rejects values JSON would erase or coerce, non-plain/circular/aliased graphs, schema mismatches, and UTF-8 documents above the owned 20 MiB limit before queueing, forwarding, or journaling. A successful browser result that cannot cross this gate becomes one bounded `CommandOutcomeUnknown` record.

[`src/protocol/bridge.json`](../src/protocol/bridge.json) owns all resource budgets: 64 KiB control bodies; 20 MiB command/result JSON; 16 MiB encoded screenshot payloads; 128 incoming connections; 128 pending challenges per authentication scope; 64 admitted commands per connector mailbox; five automation targets per session and 256 per profile; DPR at most 4; 16,777,216 pixels per capture; 67,108,864 pixels per full page; and 200 tiles. Runtime code imports these values instead of restating them.

[`src/protocol/schema.ts`](../src/protocol/schema.ts) bounds every bridge and extension display version to 64 nonblank characters. The browser target owner applies both protocol-owned target quotas before creating a tab.

The stable axis is the wire domain (`tab`, `page`, `input`, and internal `system`). The change axis is which atomic operation schemas are active in Pi's model context. Changing disclosure never changes the wire algebra.

## Pi runtime

[`src/pi/extension.ts`](../src/pi/extension.ts) registers every generated atomic tool once. Authorization activates only `chrome_navigate`, `chrome_snapshot`, `chrome_read`, `chrome_click`, `chrome_fill`, `chrome_press`, and `chrome_enable`. `chrome_enable` activates the generated tools in one advanced profile with `setActiveTools()`; Pi rebuilds the system prompt immediately. Deauthorization removes every generated Chrome tool. Each atomic call is projected through its operation descriptor and forwarded as the same `WireCommand` algebra with session context.

[`src/pi/session-runtime-owner.ts`](../src/pi/session-runtime-owner.ts) owns the only live session projection. Session start, tree navigation, and shutdown run through one serialized transition path; every transition advances an epoch and only a matching epoch plus opaque `SessionScope` capability can publish or mutate state. Cleanup captures the previous scope instead of rereading a newer context. [`src/pi/authorization-owner.ts`](../src/pi/authorization-owner.ts) owns the versioned authorization/background entry on that scope's Pi branch. A malformed latest entry, a current branch missing an entry when the session contains one elsewhere, or a session with no authorization entry appends the canonical locked state. Only an explicit authorization transition enables Chrome control. Timed authorization uses a unique generation plus absolute deadline compare-and-set, so interrupting an old timer is only an optimization.

Tool admission returns the opaque session capability, authorization generation, and the claim from
[`src/pi/run-connector-owner.ts`](../src/pi/run-connector-owner.ts). That owner projects one explicit
session route: an exact Terminal connector, a live Web claim, or an attached Web route whose claim
is unavailable. `before_agent_start` never chooses a fallback. The admission effect revalidates the
authorization, route, and run generations at the actual broker/owner submission point. Rebinding
invalidates claims that have not crossed that point without interrupting commands already admitted
by the broker.

Pi SDK 0.80.6 mutates its in-memory ledger before its synchronous `appendEntry` disk write can throw. The durable outcome of that error is therefore unknown. `SessionRuntimeOwner` records process-local poison by session key, disables tools, and requires `/chrome revoke` to append a fresh canonical lock before repairing the projection. A hard process crash loses that evidence; only a future durably acknowledged or transactional Pi append API can remove this residual ambiguity.

[`src/core/broker.ts`](../src/core/broker.ts) owns one isolated mailbox per profile connector: command queueing, explicit queued/executing state, deferred replies, timeout, cancellation, connection state, and shutdown. Delivery is single-flight per connector, so a second poll cannot claim another command while one is executing or completing. A result can complete only an executing command in the same connector mailbox. A timeout before delivery is retryable; timeout or shutdown after delivery is `CommandOutcomeUnknown` and is never transparently retried. Global broker stop is terminal: later connector registration cannot republish a mailbox, and only a newly constructed bridge runtime can accept work. [`src/pi/node-bridge.ts`](../src/pi/node-bridge.ts) binds the persisted connector before accepting authenticated polling or results.

[`src/pi/connector-binding.ts`](../src/pi/connector-binding.ts) is the Terminal source of truth for
the single durable connector at `profile-connector-binding.json`.
[`src/pi/session-connector-binding.ts`](../src/pi/session-connector-binding.ts) persists Web route
intent independently from live claims. [`src/pi/connector-owner.ts`](../src/pi/connector-owner.ts)
combines those facts and is the only owner of broker register/drop, connector-id consistency,
authentication lookup, and release/use linearization. Claim expiry removes connector authority but
preserves the unavailable route. Rebind or detach rejects new uses of the old generation and waits
for admitted uses without blocking result authentication.

[`src/protocol/timeout.ts`](../src/protocol/timeout.ts) evaluates the deadline kind required by every operation descriptor. It owns both deadlines: the browser execution budget and the strictly larger bridge delivery budget. A wait budget includes its requested timeout, poll interval, and owned overhead; result posting has a fixed grace window before the caller can time out. Adding an operation without a deadline kind is a compile-time error.

The first Pi process binds `127.0.0.1:17318`. The bridge is owned by that process, not by an individual session. Owner, connector, and pairing traffic use six separate HMAC domains: a server-proof and request-proof domain for each credential class. The client first sends a fresh client nonce, verifies that the listener possesses the expected credential, and only then sends the actual request. Every request proof binds the bridge epoch, TTL-bounded one-shot nonce, protocol fingerprint, method, path, and body hash. Connector and pairing proofs additionally bind connector id, fixed extension id, exact display version, and protocol fingerprint. A new listener gets a fresh epoch, so captured proofs cannot cross ownership changes.

The user-only owner credential, out-of-band Terminal token, Web attachment capability, and connector
secret are HMAC keys and are never sent over HTTP. Pairing proofs also bind the pairing id, allowing
independent concurrent offers. The `pi-web` page receives an opaque encoded offer with only public
connector metadata; after the bridge proves capability possession, the Chrome extension sends its
secret directly in the confirmation body. Pairing and normal connector traffic retain distinct
domains.

Binding transitions and command submissions share one owner-side lifecycle gate. Pairing is allowed only while unbound. The Pi session ledger is durably locked before any binding removal starts. Normal unpair then holds the owner gate while the connector executes `cleanup-all`, and clears the binding only after acknowledgement; polling and result acknowledgement stay outside the gate so cleanup can finish. A failed or unknown cleanup keeps the binding locked in place. If an uninstall or storage loss permanently destroys connector credentials, the confirmed `forget` transition checks the exact expected connector under the same gate and clears only its binding without claiming cleanup.

The session ledger and binding store cannot form one cross-store atomic commit. Their crash invariant
is lock-before-remove: a hard crash can leave a locked session with the old binding still present,
which is safe to retry. Forgetting an unreachable identity can never prove or close its surviving
tabs; once the binding is cleared, those tabs are explicit manual-cleanup orphans.

## Browser runtime

[`src/browser/connector-identity.ts`](../src/browser/connector-identity.ts) creates one persistent `{ connectorId, secret, label }` in each profile's `chrome.storage.local`. Extension id, display version, and protocol fingerprint are projected live and are never persisted as identity. The service worker is the identity's single writer; popup reads and renames go through runtime messages. The auth configuration owns the manifest public key, the build injects it, and Node derives the fixed extension package id from the same key. Pi shows a one-time capability that the user enters only in the target profile's popup; the bridge never exposes that capability through an extension-readable query route, so competing profiles cannot claim it. Before the popup discloses its new secret in the pairing confirmation, it verifies the bridge's token-derived server proof.

[`src/browser/service-worker.ts`](../src/browser/service-worker.ts) is the MV3 Effect runtime. Its
external message boundary accepts only `http://localhost:30141` and `http://127.0.0.1:30141` pages.
[`src/browser/web-run-offer.ts`](../src/browser/web-run-offer.ts) owns bounded, expiring offers in
`chrome.storage.session`; the page receives an opaque token and pairing id, never the connector
secret. Every poll and result still carries a one-shot proof derived from the profile secret. Before
execution the worker journals the command and will not poll again until its result is acknowledged.

[`src/browser/platform.ts`](../src/browser/platform.ts) is the typed operation interpreter. Terminal Chrome state is split by owner: `platform-targets.ts` owns session tabs, `platform-cdp.ts` owns debugger sessions, `platform-input-*.ts` owns input families, and `platform-page.ts` owns page execution. None owns polling or runtime schedules.

MAIN-world page functions remain plain TypeScript because that runtime has no Effect environment. Their state, instrumentation, diagnostics, summary, query, and runtime helpers have separate module owners. Snapshot code is built as one static bundle so strict Content Security Policy does not block it. The bundle owns one tagged observation registry for action, context, and frontier capabilities. `platform-page.ts` joins the complete local DOM and Accessibility evidence before applying the output budget. Returned actions receive their exact verb capabilities; omitted semantic contexts receive locally validated FrontierRefs. `chrome_read` projects rendered content from the same context boundary without invoking AX. Input tools consume only matching action capabilities, and click performs a final hit-test after pointer movement and before mouse press.

`chrome_evaluate` runs in CDP and projects its value in the page realm before transport.
Ordinary JSON shapes are preserved. Undefined, bigint, functions, symbols, errors, non-finite
numbers, sparse arrays, cycles/shared references, non-plain objects, and projection limits become
bounded `PiChromeEvaluationMarker` objects, so JSON serialization never silently changes meaning.
`awaitPromise` selects distinct synchronous or awaiting wrappers, and every CDP evaluation receives
the operation's remaining runtime deadline so a never-settling Promise cannot pin the journal. The
operation accepts one JavaScript expression and dispatches it exactly once; a syntax or runtime
failure is returned directly instead of retrying the source as a statement body and risking duplicate
side effects.

Navigation is a generation-scoped CDP transition tied to the exact frame and loader returned by
`Page.navigate`. The default resolves at that generation's commit; explicit `waitUntilLoad: true`
resolves at its load event. Events from an earlier navigation cannot complete a later command, and
same-document navigation is reported directly because it has no new loader. The per-tab debugger
session reserves the generation before registering its one-shot init script and owns navigation
plus script removal as one lease; a concurrent navigation cannot replace the active script. If
direct script removal fails, the runtime resets the entire debugger session because detach proves
the Page-domain registration is gone. If both removal and reset fail, all failures are preserved,
the tainted lease remains quarantined, and no later command can reuse that debugger session until a
reset succeeds.

Snapshot-capable input has one result algebra: the action receipt is independent from the
post-action verification state. Observation success carries a snapshot; observation execution or
route-transition failure carries a bounded unavailable reason. The latter is not an action failure
and cannot trigger replay. The operation descriptor owns this result contract, while the existing
snapshot budgets and transport validator remain the only output-boundary owners.

Navigation may carry one nested snapshot descriptor. The navigation and observation share the
already-resolved exact tab id; the deadline evaluator adds the page-observation budget only for
that composed form. Wait predicates return a typed positive or negative observation. Known
pre-effect rejections keep their machine-readable code/details, while only failures that can occur
after dispatch are projected as outcome-unknown.

Screenshots are captured by `Page.captureScreenshot` against the already-resolved exact tab id.
Viewport capture returns one image; full-page capture uses CDP clip geometry to return bounded tiles
without activating the tab or scrolling the document. Protocol-owned geometry limits preflight the
page width, height, viewport, device pixel ratio, per-capture pixels, and full-page total pixels before the first
bitmap capture; viewport capture uses the same per-capture raster bound without tile semantics. The
Pi runtime validates MIME, complete tile geometry, paths, and real-path
containment before publishing the image or tile-set manifest.

## Session targets

Each Pi session has a stable key and owns a set of at most five automation targets; the profile-wide
total is at most 256. `chrome.storage.session` owns one browser epoch that survives MV3 worker
suspension but not extension reload/update or browser restart. One `piChromeAutomationTargets` map
in `chrome.storage.local` stores each session's set of exact
`allocating(epoch, nonce) | owned(epoch, tabId)` records, and one transition lock linearizes
read-modify-write with tab-removal events. `tabs.onRemoved` reads only that key, never the connector
secret or durable command journal. Within one epoch, only exact recorded tab ids are owned; an
allocating record may recover only the tab with its unique allocation URL. Tab-group titles are
display-only and are never queried to select a tab, group, or window.

The allocation URL is an extension-owned bootstrap document carrying the nonce in its fragment;
it never depends on a bridge HTTP route. A new tab remains inactive while its requested destination
reaches the navigation-commit milestone. Only then may the allocator focus the window, activate the
tab, and return the observed destination. The bootstrap URL is therefore recovery state, never a
successful tool result or a user-visible intermediate page.

Implicit target resolution is a pure function of owned-set cardinality: zero may allocate, one
resolves, and more than one returns `ambiguous-owned-target` with bounded target summaries. No
primary, active, current, or last-used ownership pointer exists.

An epoch mismatch or unobserved missing tab fails closed. `/chrome doctor` reports stale targets,
and `/chrome cleanup` removes only stale records; it never adopts or closes a tab from another
epoch. The next implicit page/input call can then allocate a new target. An exact `tabs.onRemoved`
event clears only the matching current-epoch member. MV3 worker suspension reuses the same epoch
and exact tab ids without a second state source.

Profile-wide `cleanup-all` applies the same proof to every set member. Current-epoch owned tab ids
and uniquely resolved allocation URLs may be closed; stale or out-of-profile records are only
removed. An ambiguous allocation URL fails the whole cleanup plan before any tab is closed.

The tab allocator uses only an existing non-incognito normal window of the paired profile, and joins the session tab group. If no such window exists, normal automation fails and asks the user to open the paired Chrome profile; it never calls `chrome.windows.create`, launches a browser, or creates a profile. The separate macOS `/chrome onboard` UX may ask the OS to open ordinary Google Chrome at `chrome://extensions` and reveal the extension folder.

An explicit target is exactly one of:

```json
{ "by": "id", "value": 42 }
{ "by": "url", "value": "github.com" }
{ "by": "title", "value": "GitHub" }
```

Tab management without an explicit target may act only on an existing session-owned target. Page/input operations may create that target. No path falls back to the user's active tab.

`chrome_tab_new` uses the same allocator and appends an owned target until either quota is reached.
URL/title selectors must resolve to exactly one tab; multiple matches fail and require an exact
numeric tab id.

The selector is resolved once when the command enters the interpreter. The resulting tab object and
id are carried through every nested page/input helper; no helper re-runs the URL/title selector
after navigation, focus changes, or tab metadata updates.

An explicitly selected user tab is never implicitly added to a Pi group. Group projection belongs only to the session-owned target; changing a user tab's group requires an explicit `chrome_tab_group` call.

## Build boundary

`vp run build` uses the Vite+ build core to bundle the MV3 worker, pairing popup, and snapshot script as independent IIFEs targeting Chrome 120, injects a Chrome-compatible numeric package version, `minimum_chrome_version: "120"`, and the loopback bridge origin, and rejects Node dependencies in browser bundles. It prepares and validates a sibling staging directory before touching `dist/browser-extension`, so prepare or validation failure leaves the old output intact. If staging publication fails after the old output was moved, the build attempts restoration. If restoration also fails, an `AggregateError` preserves both failures and names the backup path that still owns the old output. If new publication succeeds but old-backup cleanup fails, the new output remains live and the backup remains recoverable. On the next run, one unique backup is restored when live output is absent or removed when live output exists; stale staging is removed, while multiple backups fail closed because last-known-good ownership is ambiguous. Cleanup failure is preserved alongside the primary failure instead of replacing it. Smoke builds inject a random fake-bridge port into a temporary output directory; they never load the production `17318` artifact.

## Package boundary

The npm package publishes only the transitive TypeScript closure of `src/pi/extension.ts` under `src/core`, `src/pi`, and `src/protocol`; the complete `dist/browser-extension`; and project documentation/license files. Repository browser source under `src/browser`, build scripts, and `test-suite` are excluded. `vp run package:artifact` packs with lifecycle scripts disabled, rejects a missing runtime dependency or any source outside that closure, rejects tests and unexpected `dist` output, validates the extension graph, installs the tarball into a temporary offline consumer, and imports the installed Pi entry. Temporary cleanup errors are aggregated with the primary package failure.
