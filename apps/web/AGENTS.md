# Pi Agent Web — development notes

## Commands

```bash
pnpm exec vp dev         # http://127.0.0.1:30141
pnpm exec vp check
pnpm exec vp run ci:typecheck
pnpm exec vp test
pnpm effect:scan
pnpm exec vp build
pnpm test:e2e
pnpm test:package
```

Runtime requirements: Node `>=22.19.0`, pnpm `10.11.0`, Vite Plus `0.2.4`, and TypeScript `7.0.2`. `pnpm-lock.yaml` is the only lockfile. Effect and its ecosystem packages are pinned to `4.0.0-beta.98`; do not introduce V3 packages or float beta versions. `@effect/tsgo` is the only Effect diagnostics provider; do not restore the legacy language-service package.

## Ownership invariant

- Pi SDK and Pi `.jsonl` files own agent/session truth.
- TanStack Start owns the document shell, file routes, SPA fallback, and Nitro entry.
- Effect HttpApi owns every `/api/*` contract, decode, status, public error, and client method.
- Effect owns server/browser I/O, time, concurrency, cancellation, and scopes.
- React owns rendering, local view state, and the pure session reducer.

There is one API terminal route: `src/routes/api/$.ts`. Do not add framework-specific API routes, raw fetch wrappers, generic command endpoints, or compatibility URLs.

## Architecture

```text
Browser / React
  │  TanStack Router search.session = current session identity
  │  SessionUiState reducer accepts only the current RunId
  │  Browser Effect runtime + generated HttpApiClient
  ▼
TanStack Start SPA / src/routes/api/$.ts
  ▼
Effect HttpApi / src/api/contract.ts
  ├─ meta
  ├─ sessions
  ├─ sessionActions
  ├─ workspace
  ├─ models
  ├─ auth
  └─ packages
  ▼
Effect Layer graph
  ├─ SessionRepository ───────── read/persist Pi session files
  ├─ SessionRuntimeRegistry ──── own scoped live AgentSession handles
  ├─ FileAccessPolicy ────────── authorize filesystem/worktree targets
  ├─ WorkspaceIo/Service ─────── files, picker, commands, worktrees
  ├─ PackageIo ───────────────── skill search/install host boundary
  └─ PiAgentAdapter ──────────── only module importing Pi SDK
```

`HttpRouter.toWebHandler` builds the server Layer graph once. The Start terminal adapter disposes it during HMR. The browser has one `AtomRegistry`/Layer runtime and disposes it during HMR or browser runtime shutdown.

No OpenTelemetry exporter is configured. Do not describe the app as exporting traces/metrics merely because Effect supports spans. Add OTel only with an owned exporter/processor, runtime configuration, shutdown behavior, and acceptance test.

## Source map

```text
src/routes/
  __root.tsx                 Start document shell
  index.tsx                  SPA page + typed search schema
  api/$.ts                   only HTTP terminal adapter
src/api/
  contract.ts                all DTO/error/SSE/endpoint schemas
  server.ts                  middleware, handlers, Layer composition
src/server/
  pi-agent-adapter.ts        Pi SDK callback/Promise conversion boundary
  session-repository.ts      read-only browsing + session persistence
  session-runtime-registry.ts Starting/Active state table and handle scopes
  file-access-policy.ts      allowed-root authorization
  workspace-io.ts            filesystem/platform operations
  workspace-service.ts       project/worktree algebra
  package-io.ts              skill search/install process boundary
  app-config.ts              Config-backed HOME/platform facts
src/browser/
  http-api-client.ts         generated HttpApi client service
  runtime.ts                 one AtomRegistry + callback bridge
  browser-platform.ts        DOM/audio/clipboard/Chrome/media adapters
  preferences.ts             Schema-backed persisted preference state
  preferences-react.tsx      React useSyncExternalStore binding
src/features/session/
  session-controller.ts      browser Effect workflow
  session-ui-state.ts        pure reducer
src/components/              React rendering
src/hooks/                   thin React bindings
tests/e2e/                   isolated Playwright acceptance
scripts/                     host-only E2E/package tooling
bin/pi-web.js                packaged Nitro CLI adapter
```

`src/routeTree.gen.ts` is TanStack-generated and committed. Vite plugin order is Start → Nitro → React → Tailwind.

## API and error rules

- Add/change an endpoint only in `src/api/contract.ts`; use `Schema` for path, query, payload, success, SSE data, and errors.
- Browser callers use `withApi((client) => client.group.endpoint(...))`. Do not use raw `fetch`, `EventSource`, JSON casts, or a dynamic endpoint Proxy.
- Every mutation passes `SameOrigin`. Request decode failures pass `RequestSchemaErrors` and become tagged `InvalidInput` responses.
- Public errors are `InvalidInput`, `Forbidden`, `NotFound`, `Conflict`, `PayloadTooLarge`, `UnsupportedPlatform`, or `OperationFailed`.
- Internal adapter messages are not reflected to clients. API keys, OAuth codes, prompt bodies, and package command output must not enter public errors or logs.
- Dirty worktree is `Conflict` with `{ _tag: "DirtyWorktree", path }`.
- UI visibility is not authorization. All filesystem/worktree paths pass `FileAccessPolicy`.

## Session browsing and runtime lifecycle

Browsing is file-backed and must not create an AgentSession. `SessionRepository` uses `PiAgentAdapter.listSessions/readSession` and projects the current branch context from Pi entries.

Live runtime state is one table:

```text
session id ──► Starting(Deferred<RuntimeHandle>) | Active(RuntimeHandle)
```

Rules:

- Concurrent starts for one id share the exact `Deferred` stored in the table.
- A failed start removes only that exact `Starting` slot and permits retry.
- A handle owns a closeable `Scope`, activity queue, idle fiber, Pi runtime, event PubSub, subscription, and pending extension UI.
- Scope close is the only cleanup path. It disposes Pi, interrupts fibers, shuts queues/PubSub, clears pending requests, and removes the exact table slot.
- Idle handles close after ten minutes. Activity and runtime events reset the deadline.
- Prompt fibers are forked into the handle scope. Abort cancels Pi work; closing the handle interrupts all remaining work.
- Registry shutdown closes every active handle.

### Fork is a destructive runtime boundary

Pi's fork mutates the inner AgentSession identity in place. On a successful fork, `SessionRuntimeRegistry.forkSession` closes the old handle immediately. Keeping it registered under the parent id corrupts later `parentSession` chains.

Fork and in-session branch are different:

- Fork creates a new `.jsonl` file and sidebar child.
- Navigate changes the active leaf inside one file and uses the context endpoint.

### SSE ordering

The prompt response returns before the browser opens its session SSE connection. Runtime events therefore use a sliding PubSub with capacity 256 and replay 64. This preserves the initial run events for a late subscriber while bounding slow-tab memory. The registry subscribes before returning an active handle. `RunId` filtering makes replay from older runs harmless.

Registry-change PubSub carries notifications only, never a second state snapshot. Running ids are derived from the table and each runtime snapshot.

## Browser state and I/O

- `search.session` is the current-session SSOT. `selectedSession` is derived from that id plus the session collection.
- `SessionUiState` is a pure reducer. Snapshot/event reconciliation cannot replace a newer `RunId` with an older run.
- `session-controller.ts` owns SSE reconnect and scheduled reconciliation; React cleanup cancels its fiber.
- Locale, theme, sound, drafts, and unread ids share one versioned `BrowserPreferencesState` Schema and storage key. There is no legacy-shape migration.
- DOM listeners, media queries, animation frames, timers, clipboard, audio, URL navigation, and Chrome messaging belong to `BrowserPlatform` or another named browser adapter. Components may request an adapter effect; they must not register global listeners directly.
- Mermaid is dynamically imported only when preview is requested; keep it out of the initial client chunk.

## Pi SDK boundary

Only `src/server/pi-agent-adapter.ts` may import `@earendil-works/pi-*`. Promise/callback and SDK structural values are converted there into Effect, Scope, PubSub, Deferred, and contract Schema values.

Pi behaviors that must remain intact:

- tool preset selection merges active extension tools;
- `!`/`!!` uses Pi's `executeBash`, `recordBashResult`, and `abortBash` path;
- completion sound is unlocked by a user gesture;
- model default comes from Pi settings;
- OAuth/API key storage uses Pi `AuthStorage` and never returns a raw key;
- plugin operations use Pi `SettingsManager`/`DefaultPackageManager`;
- skill listing uses `DefaultResourceLoader` and toggle edits only `disable-model-invocation`;
- exported HTML uses Pi's exporter and patches deep recursive traversal.

### pi-chrome route ownership

Chrome routing is session-owned, not prompt-owned. The browser completes prepare → `web-attach` → browser confirmation → `web-assert`; failed confirmation compensates with `web-detach`. Authorization status does not prove a live connector. Offline/expired Web routing must not silently fall back to Terminal; `/chrome revoke` is explicit detach.

## File/worktree boundary

Allowed roots are derived from session cwd/project roots, `~/pi-cwd-*`, and explicit cwd/default/worktree admissions. Existing targets resolve real paths before containment checks, preventing symlink escape.

Worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused. Dirty removal returns typed conflict and requires an explicit force retry. Removed-worktree session cwds still resolve to the main project.

## Package boundary

Nitro emits `.output/server/index.mjs` with the `node-server` preset. `bin/pi-web.js` parses `-p/--port` and `-H/--hostname`, imports that entry, waits for `/api/health`, and then opens the browser unless disabled.

Published files are only `bin`, `.output`, `public`, and `package.json`. `.output/server/node_modules` is excluded so the consumer installs native Pi dependencies for its platform. The package gate must pass in empty npm and pnpm consumers on macOS, Linux, and Windows.

## Pi session format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/parent.jsonl"}
{"type":"model_change","id":"<id>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<id>","parentId":"<id>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<id>","parentId":"<id>","message":{"role":"assistant","content":[]}}
{"type":"message","id":"<id>","parentId":"<id>","message":{"role":"toolResult","toolCallId":"...","content":[]}}
{"type":"compaction","id":"<id>","parentId":"<id>","summary":"...","firstKeptEntryId":"<id>","tokensBefore":0}
{"type":"session_info","id":"<id>","parentId":"<id>","name":"..."}
```

`parentSession` is sidebar metadata, not chat content. `SessionContext.entryIds` is parallel to displayed messages and is required for fork/navigate actions.

## Completion gates

```bash
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp run ci:typecheck
pnpm exec vp test
pnpm effect:scan
pnpm exec vp build
pnpm test:e2e
pnpm test:package
git diff --check
```

Also prove by search that there are no Next imports/routes, second lockfile, raw browser fetch/EventSource, business-layer Node fs/path/process-env, or raw timers. Do not keep deleted boundaries as aliases, empty shells, compatibility adapters, or shadow state.
