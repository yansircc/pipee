# Suite release

`main` is the only release source. `.github/workflows/release.yml` maps one source SHA to one Suite version and four immutable npm archives. The Chrome extension embedded in `@yansircc/pi-chrome` has that same version and source SHA.

```text
source SHA
→ Linux verifies source and packs four archives once
→ macOS and Windows download and consume those exact archives
→ release commit + suite-v<version> tag
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

Local source and candidate gates:

```bash
pnpm verify
pnpm release:verify
git diff --check
```

Release evidence must include the source SHA, release commit, tag, workflow run, four archive integrities, Chrome extension version, public registry equality, and successful npm/pnpm public consumer installs.
