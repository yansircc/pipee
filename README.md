# Pi Suite

Pi Suite is the source and compatibility release repository for Pi Agent Web and its companion extensions.

## Workspaces

- `apps/web` — TanStack Start web host for Pi sessions.
- `extensions/loop` — durable scheduled and dynamic session automation.
- `extensions/weixin` — Weixin iLink bridge bound to existing Pi sessions.
- `extensions/chrome` — Pi Chrome bridge plus its matching browser extension.
- `protocols/companion-contracts` — schemas shared across the host/extension boundary.

The npm packages keep independent versions. A supported installation is the exact archive set recorded by a Suite Release manifest under `release/`.

## Development

```bash
pnpm install
pnpm verify
```

`pnpm build:candidates -- --development` builds and packs each workspace once, records archive integrity, and marks the result non-releasable while the Git worktree is dirty. A releasable candidate requires a clean committed source tree.
