# Pi Suite

Pi Suite is the source and compatibility release repository for Pi Agent Web and its companion extensions.

## Workspaces

- `apps/web` — TanStack Start web host for Pi sessions.
- `extensions/loop` — durable scheduled and dynamic session automation.
- `extensions/weixin` — Weixin iLink bridge bound to existing Pi sessions.
- `extensions/chrome` — Pi Chrome bridge plus its matching browser extension.
- `packages/host-runtime` — scoped host mechanisms shared by extensions, currently cross-process leases.
- `protocols/companion-contracts` — schemas shared across the host/extension boundary.

The four public npm packages version independently. A source change declares its public release set under `release/changes/`; packages outside that set keep their versions and are not published. The Chrome browser extension remains part of the `@yansircc/pi-chrome` release unit and shares its version. A supported release is the exact selected archive set and integrities recorded by the candidate manifest under `release/`.

## Development

```bash
pnpm install
pnpm verify
pnpm release:verify
pnpm release:preflight
```

`pnpm release:build-candidates -- --development` builds and packs each workspace once, records archive integrity, and marks the result non-releasable while the Git worktree is dirty. A releasable candidate requires a clean committed source tree.

`pnpm release:preflight` clones the committed HEAD into a clean Apple Linux container, installs from the frozen lockfile, and runs the same candidate pipeline used by Actions. `pnpm push:release` is the thin clean-tree preflight-and-push entrypoint.

See [docs/release.md](docs/release.md) for the OIDC release transition and evidence contract.
