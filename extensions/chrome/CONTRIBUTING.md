# Contributing to pi-chrome

Thanks for considering a contribution. pi-chrome aims to be the **de-facto browser-control toolkit for Pi agents** — that means a few non-negotiables.

## Non-negotiables

1. **No re-login.** Every change must keep working against the user's already-signed-in Chrome profile. Anything that requires a fresh profile or extra auth steps is out of scope.
2. **Verifiable action results.** Input tools must return structured details and support `includeSnapshot` where verification matters. Agents need enough evidence to avoid blind retries.
3. **Chrome real input.** Interactive controls use Chrome's input layer through `chrome.debugger`; do not re-expose synthetic/untrusted input as public UX.
4. **Benchmarks gate features.** Add a page in `test-suite/` that fails before your change and passes after. We accept PRs faster when there's a green/red verdict to point at.
5. **One transport truth.** Tool-only preferences and filesystem paths must be projected out before the wire. Every command/result must survive the bounded JSON/schema gate without coercion or fallback.

## Local dev

```bash
pnpm install
pnpm run verify

# Link from a checkout
pi install ./pi-chrome

# Run the benchmark dashboard
cd test-suite
python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

## Adding a new operation

1. Add one descriptor to `src/protocol/operation-contract.ts`: tool call, wire call/projection, result contract, and deadline kind. Do not add a second operation list to `schema.ts`.
2. Add its exhaustive interpreter entry in `src/browser/platform.ts` and implement it in the matching `platform-*` adapter owner; tool registration, wire decoding, result validation, fingerprinting, and timeouts derive from the descriptor.
3. Resolve a tab selector once and pass the resulting exact tab through nested helpers. Do not let shared logic re-query active/URL/title state.
4. Return bounded JSON details and support `includeSnapshot` for user-visible state changes when relevant. Non-JSON values need an explicit projection, not `JSON.stringify` coercion.
5. Add a benchmark page under `test-suite/challenges/` and a manifest entry.
6. Update the public examples when the operation introduces a new capability class.

## Filing a bug

Include:

- `/chrome doctor` output
- `pi-chrome` version + extension version (the `doctor` output prints both)
- The exact tool call + the result envelope you got
- Page URL or a minimal repro page in `test-suite/`

## Releasing

- Add the release entry to `CHANGELOG.md`.
- Preserve the build graph's Chrome 120 minimum unless the runtime contract is intentionally raised with tests and documentation.
- Run `vp run release` with a real Chrome for Testing or Chromium executable available.
- Declare a Chrome release with a JSON changeset under `release/changes/`, naming `@yansircc/pi-chrome` and a `patch`, `minor`, or `major` bump. A push without that changeset does not change or publish Chrome. CI owns `package.json` version changes, the release commit, and package tag.
- GitHub Actions packs once, runs the Linux archive/domain baseline, loads that exact candidate through Pi on macOS and Windows, publishes it through npm Trusted Publishing with provenance, and proves the public registry integrity matches. Do not publish or tag the same version manually.

## Code of conduct

Be kind, be precise, ship things. PRs that break the "no re-login" promise will be closed with a note explaining which non-negotiable they hit.
