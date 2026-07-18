# Revised decision: CI-owned release witness and promotion

## Outcome

Adopt candidate-ref validation and exact promotion as the target architecture,
but do not remove the mandatory local preflight in the same step that creates
the missing CI coverage.

The cutover is complete only after the shadow CI path has demonstrated every
required check, GitHub rules make the promoter exclusive, and the privileged
path executes no candidate-controlled repository code.

Do not continuously witness every commit. Eagerly witness only an explicit
release-candidate ref. A witness expires with its retained archive; an expired
candidate must be rebuilt and re-witnessed.

## Identities and invariant

```text
S = committed development source
R = deterministic release-candidate commit derived from S and the release plan
A = one candidate archive bundle built from R
D = sha256(A)
W = complete witness set bound to (R, D)

Promotable(R, A) iff
  Parent(R) = current main
  and ValidReleaseRecord(R, S)
  and Digest(A) = D
  and W = Quality(R)
        intersect CandidateAcceptance(R, D)
        intersect ConsumerAcceptance(R, D)
        intersect ChromeAcceptance(R, D)
        intersect PlatformAcceptance(R, D)
```

Only `R` may be fast-forwarded to `main`; no release-record content commit is
created after witnessing. Only the archives contained in `A` may be published;
the privileged path may not rebuild or repack them.

Local materialization of `R` is source construction, not a validation gate. It
may deterministically bump the selected manifests, create the release-record
commit, and reject a dirty/non-ancestral source. It performs no dependency
install, build, test, browser operation, or container execution. CI independently
validates the release-record derivation before accepting `R`.

## CI ownership map

| Witness | Command or mechanism | Runner | Input |
| --- | --- | --- | --- |
| Source identity | install-free classifier plus release-record validation | Ubuntu | `R` |
| Workspace quality | `pnpm verify` | Ubuntu | `R` |
| Candidate construction | existing candidate builder, once | Ubuntu | `R` |
| Candidate contract | `pnpm verify:candidates` | Ubuntu | `R, A, D` |
| Consumer contract | `pnpm verify:consumers` | Ubuntu | `R, A, D` |
| Chrome archive | `pnpm verify:chrome-candidate` | Ubuntu | `R, A, D` |
| Chrome connector | `pnpm --filter @yansircc/pi-chrome run release:check` | hosted macOS | `R` plus explicitly provisioned Chrome dependencies |
| Platform archive | `pnpm verify:platform` | hosted macOS and Windows, parallel | `R, A, D` |
| Public acceptance | `pnpm verify:registry` | Ubuntu, after publication | published integrities from `A` |

`pnpm verify` retains root `test:release` and every package `verify`, including
Pi Web e2e. The workflow contract tests must assert inclusion of these owners;
the current assertions that exclude them must be deleted or inverted.

The candidate builder is the only archive producer. Every archive consumer
downloads the artifact from the exact candidate run and checks `D`. No platform
job builds or packs.

## Hosted-runner fidelity gate

The missing checks first run as shadow Actions jobs while local preflight
remains authoritative. Cutover requires all of the following:

1. Browser and system dependencies are explicitly provisioned rather than
   inherited accidentally from a runner image.
2. Pi Web e2e, consumer browser/SSE/CLI/health/port-release assertions, and the
   Chrome connector check execute their real assertions; absence of a browser,
   connector, port, or service fails rather than skips.
3. At least three consecutive full release-candidate runs complete on the
   intended hosted runner images, including a clean rerun with restored pnpm
   store but no reused build output.
4. Step summaries record queue, setup, install, build, and assertion durations.
5. A forced failure in each migrated job blocks the aggregate witness.

The three-run observation is evidence of runner reliability, not the
correctness criterion. Correctness comes from explicit provisioning, executed
assertions, exact artifact identity, and fail-closed aggregation.

If any mandatory check cannot run faithfully in hosted Actions, CI-only
cutover is abandoned. The local preflight remains required until an equivalent
remote witness exists.

## Privilege boundary

Validation workflows have read-only repository permissions and no npm OIDC or
main/tag write authority.

Promotion/publication is a separate default-branch-controlled workflow. It:

1. Does not checkout `R`.
2. Does not run `pnpm install`, package lifecycle hooks, or any file/script from
   `R` or `A`.
3. Accepts only a completed, allowlisted validation workflow from this
   repository, triggered for an explicit `release-candidate/**` ref.
4. Verifies workflow ID, repository, event, head ref, head SHA `R`, conclusion,
   artifact ID, artifact digest `D`, witness manifest, and candidate retention.
5. Re-reads `main` and requires `Parent(R) = main`; ancestry alone is
   insufficient.
6. Fast-forwards `main` to `R` and creates only the tags bound by the witnessed
   release record.
7. Publishes exact `.tgz` files with lifecycle scripts disabled. The publishing
   helper is pinned/trusted control-plane code, not repository code from `R`.
8. Persists and byte-compares the exact candidate before the first irreversible
   npm publish, then uses idempotent exact-integrity publication semantics.

The promoter uses a dedicated GitHub App or equivalent actor allowed by the
ruleset. Candidate workflows never receive that credential. npm Trusted
Publishing is scoped to the privileged workflow and environment.

## GitHub enforcement

Before cutover, configure repository rules that:

- restrict `refs/heads/main` updates to the promoter actor;
- restrict release-tag namespaces to the promoter actor;
- prohibit force pushes and deletions;
- prevent candidate validation jobs from bypassing those rules;
- require the promotion environment for npm OIDC publication.

Run negative acceptance probes using non-promoter credentials:

1. direct push to `main` is rejected;
2. direct release-tag creation is rejected;
3. a candidate workflow token cannot update `main` or release tags;
4. the promoter rejects a wrong workflow, repository, ref, SHA, artifact ID,
   digest, incomplete witness, stale parent, expired artifact, or rebuilt
   archive.

Current observed GitHub state has no ruleset and no main protection. Therefore
the CI-only cutover is presently forbidden.

## Concurrency and recovery

- Validation may run concurrently per `R`.
- Promotion and publication use one global, non-cancelling concurrency group.
- Remove the unsupported/ambiguous `queue: max` field; use only documented
  Actions concurrency fields and explicit stale-parent rejection.
- When two candidates share a parent, the first successful promotion changes
  `main`; the second fails `Parent(R) = main` and must be regenerated.
- Runs may be cancelled only before promotion begins.
- After `main` advances, failures are retried against the same `R, D, A`; no
  rebuild is permitted.
- Public registry propagation remains a separate retrying acceptance boundary,
  not evidence that npm publish itself failed.

## Retention

Only explicit release-candidate refs trigger eager witnesses. Their run artifact
and witness are valid for 14 days. The candidate UI/status must expose the
expiry. Promotion after expiry fails closed and requires a new build plus a new
complete witness.

Do not claim indefinite or universal continuous-witness reuse. If measured
release behavior later requires a longer window, add a separately audited
immutable candidate store keyed by `(R, D)`; do not silently extend trust from
metadata after archive bytes expire.

## Latency model

Local release submission performs only deterministic release-candidate
materialization and push. Its target is seconds, with no heavy local gate.

CI critical path is measured rather than assumed:

```text
source identity
  -> max(
       workspace quality,
       candidate build
         -> max(candidate, consumers, Chrome archive, Chrome connector,
                macOS platform, Windows platform)
     )
  -> serialized promotion/publication
```

Split a job only when its measured work exceeds repeated queue/setup/install
cost. Cache only content-addressed dependency downloads. Do not cache workspace
build output, test results, or candidate archives as substitutes for evidence.

## Rollout

1. Add shadow CI owners for root quality, consumers, Chrome archive/connector,
   and the exact candidate identity. Keep local preflight mandatory.
2. Make the release-record commit `R` exist before the witness DAG; remove the
   post-witness content commit from publish.
3. Run hosted-runner fidelity acceptance and collect timing evidence.
4. Implement the no-checkout/no-candidate-code promoter and its negative tests.
5. Configure and live-test main/tag rulesets.
6. Switch release submission from direct `main` push to
   `release-candidate/**` and require the aggregate witness.
7. Only after steps 1-6 pass, remove local preflight from `push:release` and
   rename it to an optional Linux reproduction command.
8. Remove the old push-to-main release path. There is no compatibility double
   path.

## Finding disposition map

- F1: addressed by the CI ownership map and staged cutover.
- F2: addressed by hosted-runner fidelity acceptance and the abandon condition.
- F3: addressed by the separate no-checkout/no-candidate-code privileged path.
- F4: addressed by mandatory server-side main/tag enforcement and negative
  probes; current state explicitly forbids cutover.
- F5: addressed by creating and witnessing `R` before promotion, with no later
  content commit.
- F6: addressed by explicit-candidate-only eager witnessing and a finite,
  fail-closed 14-day witness lifetime.

## Final decision

Retain architecture C as the target and revise its rollout and identity model
as above. Retain mandatory local preflight only as a temporary migration gate.
Its removal condition is the successful completion of rollout steps 1-6.

Do not adopt continuous witnessing for every commit or a persistent self-hosted
runner as part of v1. Reconsider either only after hosted Actions timing evidence
shows that validation starts too late or queue/runtime dominates the critical
path.
