# pi-chrome

Agent-first Chrome tools for Pi. Complex browser intent stays in Chat; there is no `/chrome`
command or authorization control plane. The cross-Session Web Surface is a browser-activity supervision
console: it projects explicit running tool activity, bounded live events, recent evidence, and idle
Session-owned tabs. It does not recreate navigation, click, fill, snapshot, or screenshot controls.

## Install

```bash
pi install npm:@yansircc/pi-chrome
```

Download the package-provided browser-extension ZIP from Pipee, open `chrome://extensions`, enable
Developer mode, and drag the ZIP directly onto the page. If the current Chrome build or enterprise policy
rejects ZIP installation, extract it and use **Load unpacked** as the fallback. The popup is read-only. Once
loaded, the extension connects to the local Pi bridge automatically.

Ask Pi to use Chrome normally. All 25 typed atomic tools and `chrome_status` are registered directly;
the Extension never reads or rewrites Pi's active-tool selection.

`chrome_status` reports one of `ready`, `waiting-for-extension`, `offline`, or `error`, plus the
extension directory when setup is incomplete. The Chrome popup stays read-only. Pipee combines
that status with Session-owned activity, evidence, and idle-tab projections. Its only mutations are
terminating the owning Session's current Chrome tool and closing one explicitly selected idle tab
after confirmation; it never mirrors the DOM or falls back to Chrome's active tab.

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
