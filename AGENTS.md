# Pi Suite development notes

## Invariant

The supported product is one exact Suite Release, not an arbitrary combination of package versions.
Every release manifest is derived from one source commit and the exact archives verified from that commit.

- Pi SDK and Pi JSONL files own session truth.
- Each extension owns its runtime and persisted state migration.
- `protocols/companion-contracts` owns cross-boundary status and control DTOs.
- `apps/web` renders those DTOs; it does not reinterpret extension internals.
- `extensions/chrome` owns both its Pi extension and browser extension. They are one release artifact.
- Package versions remain independent. The Suite Release owns only the verified compatibility relation.

Do not add compatibility guesses, duplicated schemas, generic extension command endpoints, or fallback routing.
Persisted schema changes require a fixture from the previous released version and a lossless migration test.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:packages
pnpm build:candidates -- --development
pnpm verify:candidates
```

Run package-specific commands from its directory when iterating. Never rebuild an archive after candidate verification.
