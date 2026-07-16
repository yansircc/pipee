# Pi Agent Web

Browser UI for the [Pi coding agent](https://github.com/badlogic/pi-mono). It reads Pi's existing `~/.pi/agent` state and runs `AgentSession` in-process; there is no separate database or daemon.

[中文说明](./README.zh-CN.md)

## Features

- Browse, rename, delete, export, fork, and navigate Pi `.jsonl` sessions.
- Stream prompts, tool calls, compaction, retry, extension UI, and bash output over typed SSE.
- Run Pi-native `!command` and `!!command`, including live output and abort.
- Configure models, OAuth/API keys, plugins, skills, tools, and thinking levels.
- Browse and preview files behind a server-enforced allowed-root policy.
- Create and remove Git worktrees, including a structured dirty-worktree conflict flow.
- Session-owned pi-chrome attach/assert/detach flow.
- Manage multiple session automations from `@yansircc/pi-loop`, including countdown, pause, run-now, and interval editing.
- Chinese-first UI with visible locale, theme, sound, draft, and unread preferences.

## Requirements

- Node.js `>=22.19.0`
- A working Pi installation and its normal `~/.pi/agent` configuration

The automation panel appears when the companion extension is installed:

```bash
pi install npm:@yansircc/pi-loop
```

## Install and run

```bash
pnpm add -g @yansircc/pi-web
pi-web
```

The default address is `http://127.0.0.1:30141`. The CLI opens it after `/api/health` reports ready.

```bash
pi-web -p 30200 -H 0.0.0.0
pi-web -h
pi-web -v
PORT=30200 HOST=127.0.0.1 pi-web
PI_WEB_OPEN_BROWSER=0 pi-web
```

`--port`/`-p` and `--hostname`/`-H` override `PORT` and `PI_WEB_HOST`/`HOST`.
Generic `HOSTNAME` is intentionally ignored so container or shell metadata cannot widen the listen address implicitly.

pi-web has no remote authentication boundary. Binding to `0.0.0.0`, `::`, or a non-loopback address exposes agent actions and allowed workspace files to clients that can reach that address. Until authentication is implemented, use non-loopback binding only on a trusted network or behind an authenticated SSH tunnel.

## Development

This repository is owned by pnpm 11.13.1 and Vite Plus 0.2.4. Do not add another lockfile or parallel Vite/Vitest configuration.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec vp dev         # port 30141
pnpm exec vp check
pnpm exec vp run ci:typecheck
pnpm exec vp test
pnpm effect:scan
pnpm exec vp build
pnpm test:e2e
pnpm test:package
```

`vp check` owns formatting and ordinary linting. The separate `ci:typecheck` task runs the TypeScript 7 compiler patched by `@effect/tsgo`, so Effect diagnostics remain part of the compiler gate. `pnpm test:e2e` creates an isolated HOME and Git fixture under ignored `test-results/`; it does not mutate the developer's real Pi state. `pnpm test:package` builds and packs the npm artifact, installs it into an empty consumer, verifies the packaged help/version contract, starts the CLI, and checks health, browser startup, SSE, and graceful shutdown behavior.

## Architecture

```text
Browser / React
  ├─ TanStack Router search.session (current-session SSOT)
  ├─ pure SessionUiState reducer
  └─ Effect browser controller + generated HttpApiClient
                         │
                         ▼
TanStack Start SPA + one /api/$ terminal route
                         │
                         ▼
Effect HttpApi (schemas, errors, middleware, SSE)
  ├─ SessionRepository ─────────────── Pi .jsonl files
  ├─ SessionRuntimeRegistry ────────── scoped Pi runtimes
  ├─ FileAccessPolicy / WorkspaceIo ─ filesystem + worktrees
  └─ PiAgentAdapter ───────────────── only Pi SDK import boundary
```

TanStack Start owns the document shell, file routes, SPA fallback, and Nitro build. Effect V4 owns HTTP, validation, I/O, time, concurrency, resource scopes, and browser adapters. React owns rendering and reducers.

The API contract lives in [`src/api/contract.ts`](./src/api/contract.ts). It is the only endpoint inventory and generates both server handlers and the browser client. There are no compatibility routes or generic command endpoint.

Important runtime invariants:

- Reading a session never creates an `AgentSession`.
- Registry state is exactly `Starting(Deferred) | Active(Handle)`; concurrent starts share one `Deferred`.
- A handle owns its `Scope`, idle fiber, Pi runtime, event PubSub, and pending extension UI.
- A successful fork closes the old handle immediately because Pi mutates its inner session identity.
- Each run has an opaque server-generated `RunId`; stale SSE and reconciliation results are reducer no-ops.
- Runtime events use bounded sliding delivery with replay because prompt acceptance precedes the browser SSE connection.
- Every mutation passes same-origin middleware. File and worktree authorization is enforced by `FileAccessPolicy`, not UI visibility.
- Internal adapter errors are converted to fixed public messages, so API keys, OAuth codes, and prompt bodies cannot be reflected in responses.

## Source map

```text
src/routes/              TanStack Start document, page, and /api/$ terminal route
src/api/                 HttpApi contract, handlers, and error/middleware boundary
src/server/              Pi adapter, repository, registry, workspace and policy Layers
src/browser/             shared runtime, typed API client, preferences and DOM adapters
src/features/session/    session controller and pure UI reducer
src/components/          React rendering
src/hooks/               thin React bindings
tests/e2e/               isolated Playwright acceptance
scripts/                 package and E2E host tooling
bin/pi-web.js            packaged Nitro CLI adapter
```

The npm tarball contains only `bin`, `.output`, `public`, and the manifest. `.output/server/node_modules` is excluded so native Pi dependencies are installed for the consumer's platform.

## Security boundary

`/api/workspace/files/*` is not a general filesystem API. Roots come from Pi session working directories, resolved project roots, `~/pi-cwd-*`, and locations explicitly admitted by cwd/worktree operations. Mutations require a matching request origin. Auth status endpoints never return stored secrets.

## License

MIT
