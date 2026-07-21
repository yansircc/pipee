# Suite release

The release control plane has one supported transition:

```text
development source S + tracked changesets
→ deterministic release merge commit R
→ explicit release-candidate ref
→ GitHub Actions quality + one Linux archive set
→ consumer + Chrome + macOS + Windows witnesses of R and those bytes
→ trusted promotion fast-forwards main to R
→ exact archives are persisted and published through npm OIDC
→ registry integrity and fresh public consumers
```

`R` has `origin/main` as its first parent and `S` as its second parent. Its tree contains the development source plus only the selected version bumps and deletion of the consumed changesets. No content commit is created after witnessing.

The four public packages version independently. Add one or more JSON documents under `release/changes/`:

```json
{
  "schemaVersion": 1,
  "changes": [
    { "package": "@yansircc/pipee", "bump": "minor" },
    { "package": "@yansircc/pi-chrome", "bump": "patch" }
  ]
}
```

Then commit the development source and submit it:

```bash
pnpm release:submit
```

Submission performs no dependency installation, build, test, browser operation, or container execution. It requires a clean committed source descended from the current `origin/main`, rejects development-owned public version changes, creates `R` in a temporary worktree, pushes `release-candidates/<R>`, and dispatches `release-candidate.yml` from trusted `main`.

The candidate workflow has read-only repository permissions. It runs root `pnpm verify`, builds the selected archives once on Linux, runs candidate and consumer acceptance, provisions Chrome for the connector and exact extension smoke, and fans the same archives out to macOS and Windows. The Actions artifact and witness expire after 14 days; an expired candidate must be materialized and witnessed again.

`release-promote.yml` is loaded from the trusted default branch. Its privileged job checks out only the pre-dispatch main SHA, never the candidate. It validates the release commit and archive bytes using the trusted control-plane verifier, atomically advances main and tags, persists the exact archives, and runs `npm publish --ignore-scripts --provenance`. It never installs dependencies or executes repository code from the candidate.

Public registry propagation is a separate retrying job. A successful npm publish followed by a temporary public 404 is not republished. Existing versions are reusable only when their registry integrity equals the witnessed archive.

The npm Trusted Publisher coordinates for every public package are:

```text
GitHub owner: yansircc
Repository:   pi-suite
Workflow:     release-promote.yml
Environment:  npm-release
```

No npm token, local publication command, push-to-main release path, or local preflight fallback is supported.

GitHub repository rules must reject direct updates to `main` and the release tag namespaces outside the trusted promotion workflow. Candidate code must never receive write or OIDC authority.

Release evidence is the tuple `(R, candidate artifact digest, package archive integrities, workflow run)` plus the source/base identities, selected package versions, platform witnesses, npm provenance, registry integrity equality, and fresh npm/pnpm consumer acceptance.
