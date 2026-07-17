# Suite release

`main` is the only release source. `.github/workflows/release.yml` maps one source SHA to the explicit package release set declared by JSON changesets under `release/changes/`. Each selected package receives its own next version and one immutable npm archive; unselected packages keep their versions and are not published. The Chrome extension embedded in `@yansircc/pi-chrome` is part of that package's release unit and has its exact version and source SHA.

```text
source SHA + tracked changesets
→ selected package versions
→ Linux verifies source and packs selected archives once
→ macOS and Windows download and consume those exact archives
→ release commit + source tag + per-package version tags
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

Do not change package versions, create release tags, publish archives, or add npm credentials manually. The workflow owns versions and publication. A source commit publishes nothing unless it includes a changeset. Each changeset contains one or more `{ "package", "bump" }` entries, where `bump` is `patch`, `minor`, or `major`; repeated entries for one package collapse to the largest requested bump.

```json
{
  "schemaVersion": 1,
  "changes": [
    { "package": "@yansircc/pi-web", "bump": "minor" },
    { "package": "@yansircc/pi-chrome", "bump": "patch" }
  ]
}
```

The first Linux build is the only writer of candidate bytes. The workflow stores `candidate.json` and every selected archive as one release asset named by the source SHA before calling `npm publish`. Any same-source rerun first restores a prior attempt artifact, even when the release record does not exist yet; after the source tag exists it prefers the durable release asset. It fails closed if stored bytes differ and never rebuilds or repacks a witnessed candidate. The prior attempt artifact also closes the failure window between pushing the tags and creating the release asset. Per-attempt Actions artifacts otherwise only transport the durable candidate between jobs.

Main releases use GitHub Actions' maximal concurrency queue and are isolated from pull-request groups, so pending runs are not silently replaced. The release commit is still an atomic child of its source and must advance `main` directly. Therefore, do not push another main source until the preceding release finishes. Preparation rejects a source that is no longer `origin/main` before building any candidate. If accepting overlapping main pushes while publishing every source becomes a requirement, replace this boundary with a serialized release-ledger worker; retries against a moving branch are not valid.

Local source and candidate gates:

```bash
pnpm verify
pnpm release:verify
pnpm release:preflight
git diff --check
```

`release:preflight` requires a clean committed HEAD and Apple `container`. It first proves the real Chrome connector on the macOS host, then mounts the repository read-only, clones only committed Git state into a fresh Linux workspace, installs with the frozen lockfile, and invokes `candidate-pipeline.mjs full`. Chrome for Testing has no Linux ARM64 binary, so the connector fact cannot be moved into the default container. The Actions candidate job invokes the same candidate pipeline in phases so exact-candidate restoration can remain between source verification and candidate verification. `PI_SUITE_PREFLIGHT_PLATFORM=linux/amd64` opts into Rosetta-backed amd64 execution; the default is native `linux/arm64`. The container receives 8 CPUs and 8 GB by default because Apple container's 1 GB default cannot run the parallel workspace gate; `PI_SUITE_PREFLIGHT_CPUS` and `PI_SUITE_PREFLIGHT_MEMORY` override those explicit resources.

`pnpm push:release` adds no release behavior: it requires `main`, runs `release:preflight`, proves HEAD and the worktree are unchanged, and pushes that verified commit.

Release evidence must include the source SHA, release commit, source tag, per-package tags, workflow run, selected archive integrities, Chrome extension version when selected, public registry equality, and successful npm/pnpm public consumer installs.
