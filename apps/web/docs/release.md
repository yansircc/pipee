# Automated release

`main` is the only release source. GitHub Actions maps each eligible source SHA to one version and one immutable npm archive, verifies that archive, commits the version bump, tags the release commit, publishes through npm Trusted Publishing, and confirms public registry integrity.

Do not change `package.json.version` manually, create release tags manually, run `pnpm publish`, or configure an npm token. The trusted publisher coordinates are `yansircc / pi-web / ci.yml` with no GitHub environment.

## Local gate

Run from a clean `main` checkout with the versions declared by the repository:

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

`test:package` packs once, installs the archive into empty npm and pnpm consumers, starts the packaged CLI, and checks health, page, and SSE behavior. The CI archive matrix runs the same command on Linux, macOS, and Windows against the one uploaded archive.

## Select a bump

An ordinary eligible push uses `patch`. To request a different increment, add exactly one trailer to the source commit:

```text
Release-Bump: minor
```

Accepted values are `major`, `minor`, and `patch`. The release commit records both `Release-Source` and `Release-Bump`.

## CI transition

```text
source SHA
→ verify
→ prepare version and pack once
→ three-platform archive verification
→ release commit and tag
→ OIDC publish of the same archive
→ registry integrity equality
→ public archive verification
```

A failure before `commit_release` makes commit, tag, and publication unreachable. Rerunning the same source workflow reuses the existing release only when the registry archive has the same integrity.

## Verify a release

```bash
gh run list --repo yansircc/pi-web --branch main --limit 5
gh run view <run-id> --repo yansircc/pi-web
git fetch origin main --tags
git log -1 --format=fuller origin/main
npm view @yansircc/pi-web@<version> dist.integrity --registry=https://registry.npmjs.org/
```

Completion requires the latest `main` run to succeed, the tag to point at the bot release commit, the registry integrity to equal the verified artifact, and the local branch to fast-forward to the clean release commit.
