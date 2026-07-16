# pi-chrome

Use an existing signed-in Chrome profile from [Pi](https://pi.dev) through progressively disclosed atomic tools.

```text
core: chrome_navigate chrome_snapshot chrome_read chrome_click chrome_fill chrome_press chrome_enable
advanced profiles: tabs page network capture interaction
```

All 25 atomic tools are registered, but only the core set is active by default. `chrome_enable` activates one advanced profile at runtime; Pi immediately rebuilds the tool prompt. One operation descriptor map owns each atomic name, profile, public schema, wire projection, result contract, and deadline. The browser dispatcher is an exhaustive consumer of the resulting tagged union. There are no legacy tool aliases or legacy wire actions.

## Install

```bash
pi install npm:@yansircc/pi-chrome@0.1.1
```

Then run:

```text
/chrome onboard
```

The command prints the installed `dist/browser-extension` path. Load that folder from
`chrome://extensions` with Developer mode enabled. The npm package contains a bundled Pi entry and
requires no package-local dependency install. For Pi Terminal, click the extension icon in the
profile Pi should use and enter the one-time token. For `pi-web`, install the extension in each
eligible profile but do not choose a global profile: the profile containing the `pi-web` page is
attached to that Pi session. Then verify Terminal pairing with:

```text
/chrome doctor
```

The package and Chrome manifest versions are generated from the same `package.json` version during `vp run build`. Runtime compatibility is checked separately with a SHA-256 fingerprint derived from the semantic wire contract; JSON Schema annotations such as descriptions and examples are excluded, while constraints, operation-result contracts, deadlines, and bridge/auth values remain significant. The display version does not decide compatibility, but its exact value is authenticated as part of the connector identity.

## Tool calls

Enable tab tools with `chrome_enable`:

```json
{
  "profile": "tabs"
}
```

Then call `chrome_tab_list` with `{}`.

Observe the session-owned page with `chrome_snapshot`:

```json
{
  "mode": "interactive"
}
```

The snapshot begins with an Action Graph such as `@el-12 button "Submit" [click]`. Click that fresh ref with `chrome_click`:

```json
{
  "ref": "@el-12",
  "includeSnapshot": true
}
```

Action refs are tied to live DOM nodes. A stale ref fails closed and requires another `chrome_snapshot`; role/name guessing is never used as a fallback.

Input returns an `action` receipt plus a discriminated `verification` status. When
`includeSnapshot` is requested, a dynamic-page observation failure is reported as
`verification.status: "unavailable"`; it never erases the already completed action or invites an
unsafe replay.

When an action context exceeds the observation budget, the snapshot returns a typed frontier such
as `@frontier-3 ... [expand with chrome_snapshot]`. Expand only that omitted context:

```json
{
  "ref": "@frontier-3"
}
```

Read bounded content from the exact current rendered page without loading the Action Graph:

```json
{
  "view": "outline",
  "query": "refund policy"
}
```

`chrome_read` preserves the selected profile's rendered login state. Content frontiers expand with
another `chrome_read` call; navigation remains an explicit `chrome_navigate` operation.

Target an existing tab with one tagged selector:

```json
{
  "target": { "by": "title", "value": "GitHub" },
  "mode": "interactive"
}
```

The other target forms are `{ "by": "id", "value": 42 }` and `{ "by": "url", "value": "github.com" }`.

The tagged selector is resolved once at command entry. Every page/input sub-operation then uses that
exact tab id; URL/title changes during the command cannot retarget it.

Enable the `capture` profile, then call `chrome_screenshot` to capture that tab's viewport to a local artifact:

```json
{
  "format": "png",
  "capture": {
    "kind": "viewport",
    "path": ".pi/chrome-screenshots/current.png"
  }
}
```

Use `capture: { "kind": "full-page-tiles", "directory": "..." }` for a full page. It publishes a
directory of tiles plus `manifest.json`, not a stitched image. `path` and `directory` are tool-local
artifact destinations and never cross the browser wire. CDP captures the exact tab without
activating it or scrolling its page state. Before the first full-page tile is captured, the
protocol-owned limits validate width, height, viewport, device pixel ratio, and per-capture and
full-page total raster pixels; the same per-capture bound applies to viewport images, and unsafe geometry fails
without allocating a screenshot bitmap.

## Session and safety model

Chrome control starts enabled for each Pi session and can be changed with:

```text
/chrome authorize
/chrome authorize 30m
/chrome revoke
/chrome cleanup
/chrome unpair
/chrome forget
/chrome status
/chrome background on
/chrome background off
```

Session start, tree navigation, and shutdown pass through one serialized transition owner. Each transition advances an epoch, and only the latest epoch can publish the current authorization projection; cleanup of a superseded session uses its captured scope instead of rereading the new context. Authorization and background mode are versioned custom entries on the current Pi session branch. Restarting Pi or navigating the session tree reconstructs the latest branch entry; an invalid latest entry, a branch missing an entry, or a session with no authorization entry appends the canonical `locked` state. Browser control becomes active only after an explicit `/chrome authorize`. Timed expiry compares the persisted generation and absolute deadline before locking, so an old timer cannot overwrite a newer authorization.

Tool admission carries an unforgeable in-process session capability, authorization generation,
session-route generation, and run generation. `before_agent_start` activates only the connector
already attached to the session; retries and queued continuations retain that selection. Rebinding,
revoke, expiry, or a session transition before broker admission rejects the stale command. Once
broker admission or the POST begins, that command may finish without reopening admission.

Every profile installation has its own `connectorId` and secret in `chrome.storage.local`, even when
several profiles load the same extension package. A Terminal session explicitly attaches the
durable connector selected by `/chrome onboard`. `pi-web` persists a session route to the profile
beside the page and renews its expiring live claim. Expiry or disconnection removes execution
authority but keeps that Web route attached and unavailable; only explicit detach/rebind changes it,
and no run can fall back to the Terminal binding.

`/chrome onboard` refuses to replace an existing binding; unpair the current profile first. `/chrome unpair` durably locks the Pi session before starting one owner-side transaction: it blocks new command submissions, asks the bound connector to clean every session target it can prove belongs to the current browser epoch, and clears the binding only after that result is acknowledged. Stale records are removed without closing unprovable tabs. If cleanup fails or its outcome is unknown, the binding remains and unpair reports failure.

If the extension was uninstalled or its local identity was erased, the old connector can never authenticate to perform cleanup. Normal unpair remains fail-closed. `/chrome forget` is the explicit recovery path: after confirmation it durably locks Chrome tools, clears only the exact expected connector binding, and does not claim to close any tab. Close old Pi tabs manually before onboarding another profile.

The session ledger and connector binding are separate durable stores. A hard crash between locking
and removal may leave a locked session with the old binding still present, which is safe to retry;
after a forget clears an unreachable identity, any surviving Pi tabs are manual-cleanup orphans.

Pi SDK 0.80.6 updates its in-memory ledger before its synchronous disk append can throw. Such an
error has an unknown durable outcome. `pi-chrome` poisons that session and stays fail-closed for the
rest of the current process; `/chrome revoke` repairs it only after a fresh canonical lock append
succeeds. A hard process crash loses that process-local evidence, so durable certainty requires a
future acknowledged or transactional append API from Pi.

Without an explicit target, page and input operations allocate a session-owned tab when none exists
or use it when exactly one exists. After `chrome_tab_new` gives the session several owned tabs, an
implicit call fails with their summaries and requires one exact tab id; there is no active or
last-used target pointer. A session may own at most five tabs, and the paired profile may store at
most 256 owned targets. Normal automation never launches Chrome, creates a window, or creates a
browser profile. On macOS, `/chrome onboard` may ask the OS to open the ordinary Google Chrome
`chrome://extensions` page for installation; it never creates a temporary profile. Cleanup closes
every tab provably owned by that session. Existing user tabs are touched only when a tagged target
is supplied. Newly owned tabs stay inactive on an extension-owned recovery page until the requested
destination commits, so internal allocation state is never flashed or returned as the page result.

An MV3 worker suspension keeps the current browser epoch and exact owned tab id. An extension reload/update or browser restart starts a new epoch and fails closed instead of guessing that a surviving tab is still owned. `/chrome doctor` reports this as stale; `/chrome cleanup` clears only the stale ownership record, and the next implicit page/input operation creates a new target.

The bridge listens on `127.0.0.1:17318`, rejects browser-origin command submission, and accepts
polling/results only after a domain-separated mutual HMAC handshake for an authorized connector.
The Terminal pairing token, Web offer capability, connector secret, and owner credential are HMAC
keys and are never sent over HTTP. A `pi-web` page receives only an opaque offer containing public
connector metadata; the profile secret moves directly from the extension to the proved bridge.
Pairing proofs bind an explicit pairing id, so concurrent profile offers cannot consume each other.

Commands have one lifecycle: queued, executing, durable result or outcome-unknown, then acknowledgement. The extension persists execution before acting and does not poll another command until the result is acknowledged. A delivered command is never transparently replayed after timeout, process loss, or MV3 worker interruption.

Every command, forwarded request, and successful result must round-trip through its bounded JSON
wire schema. `undefined`, `BigInt`, functions, symbols, non-finite numbers, sparse arrays, aliases,
cycles, and non-plain objects cannot leak into transport. `chrome_evaluate` projects such page
values to explicit `{ "_tag": "PiChromeEvaluationMarker", "kind": "..." }` JSON markers instead of
letting `JSON.stringify` erase or coerce them.

## Development

Requires Chrome 120 or newer, Node.js 22.19 or newer on the Node 22 line, or Node.js 24.11 or newer. Effect v4 is currently pinned to an exact beta version.

```bash
pnpm install
pnpm run verify
vp run smoke:connector
```

`pnpm run verify` runs Vite+ formatting and linting; one strict Effect-language-service TypeScript gate for the entire repository; the browser and self-contained Pi builds; Vitest; Knip; the Effect ecosystem scanner; and the generated bundle gate. CI packs one candidate on Linux, runs the raw archive loader and repository domain check there, then repeats only raw loading and registrations for that same tarball on macOS and Windows. The real Chrome connector smoke runs once before packing on Ubuntu.

`vp run smoke:connector` builds a temporary extension against a random fake-bridge port and runs it in a fresh Chrome for Testing/Chromium profile. It never polls the production bridge. Branded Chrome 137+ rejects command-line unpacked extensions, so set `PI_CHROME_SMOKE_CHROME` to a Chrome for Testing or Chromium executable on non-macOS systems or when macOS auto-discovery cannot find one.

The isolated GitHub-hosted Ubuntu release smoke passes `--no-sandbox` because its AppArmor policy
blocks Chrome's user-namespace sandbox. Remove that release-only flag when the hosted runner
provides a usable Chrome sandbox or the release smoke moves to a sandbox-capable runner.

Extension publication is staged and validated before replacement. Prepare or validation failure
leaves the previous directory untouched. If the staging-to-live rename fails after backup, the build
attempts restoration; if restoration also fails, both failures and the exact backup path are
reported. A backup-cleanup failure can leave the new output live beside the old backup. The next
build recovers or removes one unambiguous backup and fails closed when multiple backups make
ownership ambiguous.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Examples](./docs/EXAMPLES.md)
- [FAQ](./docs/FAQ.md)
- [Security](./SECURITY.md)
- [Benchmark suite](https://github.com/yansircc/pi-chrome/tree/main/test-suite)

MIT. See [LICENSE](./LICENSE).
