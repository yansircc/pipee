# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through the repository's GitHub Security Advisory page at https://github.com/yansircc/pi-chrome/security/advisories/new. Please do **not** include exploit details in a public issue.

## Threat model

`pi-chrome` is a developer tool you install knowingly. It is **not** designed to defend against:

- Hostile pages running in your Chrome trying to detect or escape automation. (Standard browser security boundaries still apply, but a hostile page that already runs in your tab can do anything that page can already do.)
- Hostile processes running as the same OS user. The bridge binds to `127.0.0.1:17318` and shared-owner routes require a user-only credential, but a process with the same user privileges can read that credential. If that threat is in scope, run pi-chrome on a separate user account.

`pi-chrome` **is** designed to:

- Never exfiltrate page state to the network. All communication is loopback (`127.0.0.1`).
- Surface every action with an honest result envelope so the agent can't silently do the wrong thing.
- Scope Chrome control and any explicit time limit or revoke state to the current Pi session.
- Reconstruct authorization from an exact, versioned entry on the current session branch; a malformed latest entry, or a branch missing an entry when the session contains one elsewhere, locks control instead of falling back to older authorization.
- Reject browser-origin command requests to the loopback bridge so ordinary web pages cannot use CORS to drive Chrome.
- Authenticate owner, connector, and pairing traffic with separate mutual-HMAC domains. The owner credential, pairing token, and bound connector secret never cross the network. A client verifies the server proof before sending the real request; request proofs bind the bridge epoch, one-shot nonce, authenticated identity, protocol fingerprint, method, path, and body hash.
- Bind connector proofs to the connector id, fixed extension id, exact display version, and protocol fingerprint. Display version remains metadata for compatibility decisions but cannot be altered without invalidating the proof. HTTP `Origin` is an additional constraint when Chrome sends it, not a credential.
- During first pairing, disclose the newly generated connector secret in the confirmation body only after the bridge proves possession of the out-of-band pairing token.
- Fail closed when the paired connector is offline; never reroute to another Chrome profile.
- Never replay a delivered command after transport loss or timeout; report `outcome-unknown` when its side effects cannot be proved.
- Require explicit confirmation before forgetting a connector whose identity was lost; this recovery clears only the binding and never claims that old tabs were closed.
- Require every command/result to round-trip through its bounded JSON schema before it is queued, forwarded, or journaled. Invalid or oversized successful results become `outcome-unknown`, not lossy JSON.
- Resolve a tagged tab selector once per command and keep the exact tab id through all page/input work. Screenshots use CDP against that tab without activating it or scrolling the document.

## The companion extension

The built Chrome extension under `dist/browser-extension/` runs with `tabs`, `tabGroups`, `scripting`, `storage`, `unlimitedStorage`, `alarms`, and `debugger`. `unlimitedStorage` is required because the command journal durably retains an unacknowledged screenshot result. Its repository source is under `src/browser/`; the npm tarball contains the built extension but excludes that browser TypeScript source. **Only install it from a package source you trust.** Pin a known-good commit if you're security-sensitive.

Resource limits are:

- 64 KiB per control body and 20 MiB per command/result JSON body.
- 16 MiB per encoded screenshot payload.
- 128 incoming bridge connections and 128 pending challenges per authentication scope.
- 64 admitted mailbox commands per connector.
- Nonblank bridge and extension display versions at most 64 characters.
- 256 durable automation-target records per Chrome profile; a new session is rejected before tab creation at capacity.
- Device pixel ratio at most 4, at most 16,777,216 pixels per capture, at most 67,108,864 pixels per full page, and at most 200 tiles.

Screenshot destinations are owned only by the Pi side. Viewport capture publishes one private image
file; full-page capture publishes a private tile directory and `manifest.json`. Relative paths are
validated against the workspace, including real-path checks against symbolic-link escape, before a
staged artifact is atomically published. Files use mode `0600` and created directories use `0700`.

## Defaults

- Loopback bridge only. No remote port. No telemetry.
- Chrome real input layer for interactive controls.
- A session with no authorization ledger entry starts enabled indefinitely without a confirmation prompt; `/chrome authorize <minutes>` applies an absolute time limit and `/chrome revoke` durably locks the current branch.
- Run-in-background optional; tab focus is observable by default (the user can see Pi acting).

Authorization is locked in the session ledger before either normal unpair or lost-identity recovery can clear a connector binding. Pi SDK 0.80.6 mutates its in-memory ledger before its synchronous disk append can throw, so an append error has an unknown durable outcome. The current `pi-chrome` process records that poison and stays fail-closed until `/chrome revoke` successfully appends a fresh canonical lock. A hard process crash loses the poison record and cannot determine whether the failed append reached disk; eliminating that residual requires a durably acknowledged or transactional Pi append API. If connector credentials are permanently lost, automatic tab cleanup is impossible: `/chrome forget` clears the exact binding after warning the user, and old Pi tabs must be closed manually.

The Pi session ledger and connector-binding file are separate durable systems, so no claim is made
that a hard crash can commit both atomically. Lock-first ordering is the safety boundary: a crash
between the lock and binding removal leaves tools locked and may leave the binding for an explicit
retry. Once `/chrome forget` clears an unreachable identity, any surviving Pi tabs are necessarily
orphaned and remain a manual-cleanup responsibility.

## Custom ports

The production extension polls `127.0.0.1:17318`. The build accepts an explicit loopback origin for isolated smoke artifacts; it has no runtime fallback to the production port.

## Supported versions

Chrome 120 is the minimum runtime. The bridge and browser extension must have the same SHA-256 semantic protocol fingerprint. Documentation-only JSON Schema annotations are excluded from the hash; executable constraints and bridge/auth values are not. The package version is display metadata rather than a compatibility selector, but the exact extension display version is bound into connector and pairing proofs. There is no compatibility fallback between different wire contracts.
