# Suite release

`main` is the only release source. `.github/workflows/release.yml` maps one source SHA to one Suite version and four immutable npm archives. The Chrome extension embedded in `@yansircc/pi-chrome` has that same version and source SHA.

```text
source SHA
→ Linux verifies source and packs four archives once
→ macOS and Windows download and consume those exact archives
→ release commit + suite-v<version> tag
→ tag-owned durable candidate asset, created before any npm publication
→ npm Trusted Publishing through GitHub OIDC
→ positive registry integrity equality
→ fresh public npm and pnpm combined consumers
```

The trusted publisher coordinates for every package are:

```text
GitHub owner: yansircc
Repository:   pi-suite
Workflow:     release.yml
Environment:  none
```

Do not change package versions, create release tags, publish archives, or add npm credentials manually. The workflow owns versions and publication. An ordinary source commit requests `patch`; exactly one `Release-Bump: minor` or `Release-Bump: major` trailer overrides it.

The first Linux build is the only writer of candidate bytes. The workflow stores `candidate.json` and all four archives as one release asset named by the source SHA before calling `npm publish`. Any same-source rerun first restores a prior attempt artifact, even when the release record does not exist yet; after the tag exists it prefers the durable release asset. It fails closed if stored bytes differ and never rebuilds or repacks a witnessed candidate. The prior attempt artifact also closes the failure window between pushing the tag and creating its release asset. Per-attempt Actions artifacts otherwise only transport the durable candidate between jobs.

Main releases use GitHub Actions' maximal concurrency queue and are isolated from pull-request groups, so pending runs are not silently replaced. The release commit is still an atomic child of its source and must advance `main` directly. Therefore, do not push another main source until the preceding release finishes. Preparation rejects a source that is no longer `origin/main` before building any candidate. If accepting overlapping main pushes while publishing every source becomes a requirement, replace this boundary with a serialized release-ledger worker; retries against a moving branch are not valid.

Local source and candidate gates:

```bash
pnpm verify
pnpm release:verify
git diff --check
```

Release evidence must include the source SHA, release commit, tag, workflow run, four archive integrities, Chrome extension version, public registry equality, and successful npm/pnpm public consumer installs.
