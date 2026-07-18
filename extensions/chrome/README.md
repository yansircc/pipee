# pi-chrome

Agent-first Chrome tools for Pi. The agent invokes the tools directly; there is no `/chrome`
command, authorization prompt, or Web control toggle.

## Install

```bash
pi install npm:@yansircc/pi-chrome
```

Load the package's `dist/browser-extension` directory from `chrome://extensions` with Developer
mode enabled. The popup is read-only. Once loaded, the extension connects to the local Pi bridge
automatically.

Ask Pi to use Chrome normally. All 25 typed atomic tools and `chrome_status` are registered directly;
the Extension never reads or rewrites Pi's active-tool selection.

`chrome_status` reports one of `ready`, `waiting-for-extension`, `offline`, or `error`, plus the
extension directory when setup is incomplete. This status is read-only in Pi Web and in the Chrome
popup.

## Operation model

One operation descriptor map owns every atomic tool name, public schema, wire projection,
result contract, and deadline. Tool registration and browser dispatch derive from that map; there
are no aliases or generic command runners.

Start with `chrome_snapshot`, then use the returned Action Graph refs:

```json
{ "mode": "interactive" }
```

```json
{ "ref": "@el-12", "includeSnapshot": true }
```

Refs identify live DOM nodes. A stale ref requires another snapshot; role/name guessing is not a
fallback. Explicit tab targets use one tagged selector:

```json
{ "target": { "by": "id", "value": 42 }, "mode": "interactive" }
```

The other target forms are `{ "by": "url", "value": "github.com" }` and
`{ "by": "title", "value": "GitHub" }`. The selector is resolved once at command entry.

Without an explicit target, page and input operations allocate a session-owned tab when none
exists, use it when exactly one exists, and require an exact target when several exist. Session
shutdown asks the browser to clean that session's owned targets.

## Development

Requires Chrome 120 or newer and Node.js 22.19 or newer.

```bash
pnpm install --frozen-lockfile
pnpm verify
vp run smoke:connector
```

The package contains a self-contained Pi Extension bundle and the built browser extension. Candidate checks
load the raw npm archive without installing package-local dependencies.

See [Architecture](./docs/ARCHITECTURE.md), [Examples](./docs/EXAMPLES.md), and
[FAQ](./docs/FAQ.md).
