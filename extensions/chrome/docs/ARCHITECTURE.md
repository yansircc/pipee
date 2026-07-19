# Architecture

The product invariant is:

```text
Complex intent -> Agent -> typed Chrome tool -> exact wire operation -> exact profile -> exact tab
Finite Web intent -> Web Surface action -> existing typed Chrome tool -> exact tab
Runtime state -> read-only projection -> Pi Web Surface and Chrome popup
```

There is no generic user-operated Chrome command or authorization control plane. The only setup
interaction is loading the unpacked extension. The Web Surface may invoke a closed set of exact-tab
operations; navigation, input, waiting, and open-ended browser tasks remain Agent-owned.

## Stable and changing axes

The stable axis is the wire domain: `tab`, `page`, `input`, and internal `system`. The changing axis
is the typed operation chosen for the next browser action. Pi alone owns active-tool selection;
Chrome registers its complete tool surface and never reads or rewrites that selection.

`src/protocol/operation-contract.ts` is the single source for operation schemas, result contracts,
deadlines, tool names, descriptions, and tool-to-wire projection. The Pi registrar and the
browser interpreter consume that algebra exhaustively.

## Pi runtime

`src/pi/extension.ts` owns one active Pi session scope. Session start or tree navigation starts the
bridge, captures the current SDK context, publishes status, and cleans the previous session target
when identity changes. Scope replacement and shutdown are serialized. The status polling fiber and
bridge are stopped on shutdown.

All 25 atomic tools and `chrome_status` are registered at extension load. Tool admission checks only
two runtime facts: the invoking Pi session identity is active, and the compatible connector is live.
It never consults permission, approval, profile, or Extension-owned visibility state.

## Bridge and browser runtime

The first Pi process owns the fixed loopback bridge; later Pi processes forward through that owner.
The bridge owns the current live connector, its mailbox, bounded JSON transport, and single-flight
result delivery. Connector state is process-local and is re-established by the extension handshake,
so installation and bridge restart do not require a pairing gesture or persisted binding.

`src/browser/service-worker.ts` owns the MV3 Effect runtime. It polls the bridge, journals a command
before execution, dispatches the typed operation, and does not poll another command until the result
is acknowledged. A delivered command is never transparently replayed after an unknown outcome.

`src/browser/platform.ts` interprets the wire algebra. Target ownership, CDP, page observation, and
input families remain separate domain owners. An implicit target is derived from the session-owned
target set: zero allocates, one resolves, and many are ambiguous. There is no active-tab fallback.

## Status projection

`ChromeStatusProjection` version 3 is the only cross-package Chrome UI contract:

```text
state: ready | waiting-for-extension | offline | error
bridge: running | stopped | error
connector?: { id, label, connected, lastSeenAt? }
extensionDirectory: string
errorMessage?: string
```

The popup renders this projection without mutation controls. Pi Web additionally derives the exact
session-owned tab list and bounded receipts through the existing operation algebra. Its finite
controls never introduce a parallel Chrome operation descriptor map.

## Delivery boundary

The monorepo root owns the lockfile, candidate builder, and release workflow. The Chrome candidate
contains the self-contained Pi bundle plus `dist/browser-extension` and `dist/web`. Host Pi APIs stay external;
ordinary runtime dependencies are bundled. Verification loads the exact raw archive and checks the
browser-extension evidence against the package version and protocol fingerprint.
