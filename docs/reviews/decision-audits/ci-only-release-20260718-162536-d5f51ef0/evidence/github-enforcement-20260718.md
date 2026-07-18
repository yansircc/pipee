# GitHub enforcement observation

- Observed at: 2026-07-18 Asia/Shanghai
- Repository: `yansircc/pi-suite`
- Local candidate HEAD: `5edfb557930abc773eb071846727d0141d00134d`
- Remote `origin/main`: `03eecd86f1bfb5f6bcdae2e5e9a6af873f332876`
- Network execution: `px run --egress routed --attach host/env`

## Repository rulesets

Read-only command:

```text
gh api repos/yansircc/pi-suite/rulesets --paginate
```

Observed response:

```json
[]
```

## Main branch protection

Read-only command:

```text
gh api repos/yansircc/pi-suite/branches/main/protection
```

Observed response and status:

```json
{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}
```

The CLI exited nonzero with `gh: Branch not protected (HTTP 404)`.

## Interpretation boundary

This receipt proves only the GitHub server state returned for the authenticated
API calls above at the observation time. It does not assert that organization
policy can never be added. At observation time, neither a repository ruleset
nor classic branch protection prevented direct writes to `main`.

