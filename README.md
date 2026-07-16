# Pi Suite

Pi Suite is the source and compatibility release repository for Pi Agent Web and its companion extensions.

## Workspaces

- `apps/web` — TanStack Start web host for Pi sessions.
- `extensions/loop` — durable scheduled and dynamic session automation.
- `extensions/weixin` — Weixin iLink bridge bound to existing Pi sessions.
- `extensions/chrome` — Pi Chrome bridge plus its matching browser extension.
- `packages/host-runtime` — scoped host mechanisms shared by extensions, currently cross-process leases.
- `protocols/companion-contracts` — schemas shared across the host/extension boundary.

The four public npm packages and the Chrome browser extension share one Suite version. A supported installation is the exact archive set recorded by the candidate manifest generated under `release/`; one source SHA owns that version and all four archive integrities.

## Development

```bash
pnpm install
pnpm verify
pnpm release:verify
```

`pnpm build:candidates -- --development` builds and packs each workspace once, records archive integrity, and marks the result non-releasable while the Git worktree is dirty. A releasable candidate requires a clean committed source tree.

See [docs/release.md](docs/release.md) for the OIDC release transition and evidence contract.
