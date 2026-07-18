# Pi Suite development contract

## Ownership

- This repository is the only source writer for Pi Web, Loop, Weixin, Chrome, and their shared contracts.
- Pi SDK session files own agent truth. Companion contracts own cross-package wire schemas. Domain state machines remain in their extension.
- Shared runtime code may own mechanisms such as scoped cross-process leases; it must not own Loop, Weixin, or Chrome policy.
- Do not add compatibility routes, state migrations, aliases, or synchronization back to the former leaf repositories.

## Effect and lifecycle

- Effect v4 owns I/O, concurrency, cancellation, time, scopes, and Layers.
- Every long-lived handle, fiber, lease, queue, PubSub, and runtime must be released by Scope close.
- Public runtime streams are read-only projections. Only the owning adapter may publish or mutate their source state.
- Run `effect-scan` through each workspace's verify command; scanner success does not replace runtime or architecture tests.

## Delivery

- The root lockfile, catalog, candidate builder, and release workflow are the only toolchain and release owners.
- Pi extensions bundle ordinary dependencies, externalize only Node built-ins and declared Pi host APIs, and must load from the raw npm archive without installing dependencies inside it.
- One release source SHA maps to one explicit public-package release set and one exact archive per selected package. Unselected packages keep their versions and are not published. Never rebuild or repack a witnessed candidate.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:packages
pnpm release:build-candidates
pnpm verify:candidates
pnpm verify:consumers
pnpm release:materialize
git diff --check
```

Keep changes invariant-first: identify the stable axis, change axis, and owner before editing. Completion means the failure class is structurally closed or its accepted boundary and removal condition are explicit.
