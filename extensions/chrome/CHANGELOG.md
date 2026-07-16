# Changelog

## 0.1.2

- Added verified npm publication for version-matched `v*` tags, including provenance and a
  public-registry Pi installation check.
- Exhaustively verified that protocol fingerprints change for every finite operation-budget
  mutation.

## 0.1.1

- Moved the Effect/tsgo preparation hook out of registry-consumer installation so the published
  archive installs without repository-only build scripts.

## 0.1.0

- Upgraded the repository compiler and local language-service substrate to TypeScript 7.0.2.
- Made navigation complete at document commit by default, with full-load waiting explicit, and
  separated input action receipts from post-action snapshot verification so dynamic-page
  observation failures cannot erase or replay an already dispatched action.
- Replaced hidden snapshot truncation with typed context/frontier references, added core
  `chrome_read` for bounded rendered-DOM content, and made ActionRef verbs executable registry
  capabilities rather than display-only hints.
- Added post-movement click hit-testing so overlays reject ref clicks before mouse press, with no
  role/name relocation or ancestor promotion for ActionRefs.

- Replaced the three polymorphic public tools with 24 descriptor-generated atomic tools. Five core
  operations plus `chrome_enable` are active by default; advanced profiles activate at runtime
  through Pi's prompt-rebuilding active-tool API, with no compatibility aliases.
- Added a compact Action Graph that joins Accessibility Tree and DOM interaction evidence through
  the existing live element registry. Snapshot verbs map to atomic tools, and stale refs remain
  fail-closed instead of falling back to role/name matching.
- Added same-profile `pi-web` routing: the page obtains an opaque, one-run offer from the Chrome
  extension in its own profile, Pi stages that exact connector, and tool admission consumes it only
  for the corresponding settled agent run.
- Generalized connector ownership to the union of one durable Terminal binding and bounded,
  expiring Web leases; broker registration, authentication, release/use races, and connector-id
  consistency now have one owner.
- Bound concurrent pairing proofs to explicit pairing ids while keeping connector secrets out of
  web pages. Missing or mismatched Web leases fail closed and never fall back to the Terminal
  connector.
- Replaced one-tab session ownership with bounded owned target sets: at most five targets per
  session and 256 per paired profile, with exact-id targeting required whenever ownership is
  ambiguous.
- Made text snapshots render runtime-owned semantic content blocks with linked headings, hrefs,
  snippets, and container context instead of discarding those facts in the Pi projection.
- Added typed URL/text wait predicates and negative timeout observations with page diagnostics;
  known pre-effect rejections no longer become generic outcome-unknown failures.
- Added optional nested snapshots to navigation so load and observation share one exact target and
  one tool round trip.
- Bound all commands to one explicitly paired Chrome profile connector with per-profile credentials.
- Added domain-separated mutual HMAC for bridge-owner, connector, and pairing traffic; credentials remain off-wire and every request is bound to a fresh server challenge plus its exact identity, path, and body.
- Added confirmed lost-connector recovery that locks authorization before clearing the exact binding and explicitly leaves unprovable tabs for manual cleanup.
- Serialized session lifecycle and authorization transitions behind epoch/capability ownership, with authorization-generation revalidation immediately before broker admission or owner command POST.
- Made authorization append failures poison the current process until `/chrome revoke` persists a fresh canonical lock, while exposing the Pi 0.80.6 crash-time durable ambiguity.
- Fixed the extension package id across unpacked install paths with a manifest public key.
- Replaced the global command queue with connector-scoped mailboxes and same-connector result validation.
- Made global broker shutdown terminal so later binding publication cannot revive stopped mailboxes.
- Made pairing a one-time out-of-band capability entered in the target profile's popup.
- Moved implicit automation into a durable, tab-specific session target in an existing normal window; removed window creation.
- Isolated browser smoke builds on random loopback ports and made package creation build the extension.
- Migrated build and smoke orchestration to strict TypeScript modules under the Vite+ task graph.
- Added durable command journaling so delivered commands are never replayed after timeout or worker interruption.
- Split tool calls from wire calls so local screenshot destinations and background preferences never reach the browser connector.
- Resolved each tagged tab selector once and pinned all nested page/input work to that exact tab id.
- Reworked screenshots around exact-tab CDP capture: viewport calls publish one private image, while full-page calls publish bounded tiles plus `manifest.json` without activating or scrolling the tab.
- Added a bounded JSON transport gate for commands, owner forwarding, results, and the durable journal; invalid or oversized successful results become `outcome-unknown`.
- Added bounded `PiChromeEvaluationMarker` projection for non-JSON evaluation values, references, objects, and truncation limits.
- Made `chrome_page evaluate` a single-dispatch expression operation; runtime syntax failures are no longer retried through a second source form.
- Made navigation completion generation-specific: `waitUntilLoad: false` waits for commit and `true` waits for load on the exact frame/loader.
- Quarantined navigation init-script leases when both direct removal and debugger reset fail, while preserving every use/cleanup failure.
- Moved result and deadline ownership into the operation descriptors, including sufficient budget for 120-second page waits.
- Replaced package-version compatibility guesses with an annotation-free semantic fingerprint; documentation-only schema edits no longer break pairing.
- Declared Chrome 120 as the generated extension minimum and browser build target.
- Bounded authenticated display versions to 64 characters and durable automation-target state to
  five targets per session and 256 targets per profile.
- Made extension directory replacement recover the unique last-known-good backup after interrupted publication and fail closed on ambiguous backups.
- Restricted the npm tarball to the Pi runtime source closure, complete built extension, and documentation; added install-and-import artifact verification.
- Preserved staging, restore, backup-cleanup, and package-temp cleanup failures alongside their primary failure instead of overwriting it.

- Replaced the previous public surface with exactly `chrome_tab`, `chrome_page`, and `chrome_input`.
- Made Effect Schema the single owner of public parameters and wire commands.
- Moved queueing, deferred replies, timeout, cancellation, polling, schedules, and lifecycle to Effect v4.
- Split Pi, loopback HTTP, MV3 runtime, Chrome platform, and page-injection boundaries.
- Made bridge ownership process-scoped and serialized concurrent owner takeover.
- Removed deprecated parameters, aliases, and string-action wire envelopes.
- Added a deterministic Vite+ browser build with package-owned manifest versioning.
- Migrated benchmark recipes and tests directly to the new tagged-operation protocol.
