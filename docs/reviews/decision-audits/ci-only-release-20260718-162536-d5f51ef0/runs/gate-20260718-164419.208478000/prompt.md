You are auditing the final disposition ledger for a decision. Do not edit files.
Return structured output with verdict LGTM or BLOCKED.
Do not reward agreement, revision volume, or consistency with prior reviewer opinions.
A refuted finding does not require a plan change. An accepted finding must be satisfied by the recorded decision.
BLOCKED is valid only for an unresolved invariant, an invalid disposition, or a mismatch between the recorded candidate and proposal.
Every BLOCKED blocker must use the same falsifiable finding schema, with a stable id. Reuse an existing id when the same causal finding survives.

## Original dossier
# Decision dossier: CI-only release control plane

## Decision Needed

Decide whether Pi Suite should remove the local container preflight from the
release path and make GitHub Actions the sole validation and promotion control
plane.

## Proposed Change

The proposed candidate is:

1. A committed source SHA is submitted to a candidate ref without changing
   `main`.
2. GitHub Actions validates that exact SHA, builds one candidate archive, and
   records the archive digest.
3. Quality, consumer, Chrome, macOS, and Windows witnesses validate the source
   SHA or that exact archive as appropriate.
4. A separate privileged promoter verifies the completed witness set without
   executing candidate code, then fast-forwards `main` to the exact source SHA.
5. Publication consumes the witnessed archive without rebuilding or repacking.
6. Local release submission performs no dependency install, build, test, or
   container execution. It may reject an uncommitted or non-ancestral source
   because those are source-identity protocol errors, not validation gates.
7. The existing container preflight remains only as an optional Linux
   reproduction command.

An optimized form continuously creates a release witness for every eligible
final candidate SHA. A later release request reuses that exact witness and
archive rather than starting validation at release time.

## Stable axis, change axis, and invariant

- Stable axis: committed source SHA, selected public release set, frozen
  lockfile, candidate archive bytes, supported platforms, npm Trusted
  Publishing, and public-registry integrity acceptance.
- Change axis: where validation executes, when validation begins, the CI job
  DAG, and how a witnessed SHA is promoted to `main`.
- Invariant: only an exact source SHA with a complete witness set may enter
  `main`, and npm may receive only the exact archive bytes bound to that
  witness. No validation result may be reused across a different SHA or
  archive digest.

## Assumptions

1. GitHub Actions remains the authorized remote execution environment for this
   repository and npm Trusted Publishing remains available there.
2. Delaying a release during a GitHub Actions outage is acceptable unless a
   separately audited emergency policy is introduced.
3. Repository rules or an equivalent GitHub enforcement mechanism can make the
   promoter the only supported writer to `main` and release tags.
4. The release candidate can be persisted and addressed by source SHA plus
   cryptographic digest.

## Non-Goals

1. Making untrusted third-party code safe on a persistent self-hosted runner.
2. Supporting an undocumented manual publication bypass.
3. Reusing mutable build directories, `node_modules`, or prior test results as
   release evidence.
4. Guaranteeing releases during a GitHub-wide control-plane outage.

## Decision Criteria

1. An unverified SHA cannot reach `main` through a supported path.
2. An unwitnessed or rebuilt archive cannot be published.
3. All checks currently supplied by local preflight remain represented in CI,
   including `pnpm verify`, candidate verification, consumer verification,
   Chrome candidate/smoke coverage, and platform witnesses.
4. Promotion is fail closed under concurrent submissions or movement of
   `main`.
5. Candidate code cannot gain promotion credentials merely by running in the
   validation workflow.
6. Local blocking time is reduced to source submission time.
7. Release-intent-to-publication latency is minimized without weakening source
   or archive identity.
8. The workflow remains diagnosable and reproducible when GitHub-hosted CI
   fails.
9. One release source SHA still maps to one explicit public-package release set
   and one exact archive per selected package.

## Observed Facts

At dossier creation time:

- `.github/workflows/release.yml` runs on pushes to `main` and pull requests.
- The candidate job installs dependencies, validates the release source, builds
  or restores candidates, verifies candidates, and uploads an artifact.
- macOS and Windows jobs witness the uploaded candidate.
- The publish job runs only after candidate and platform witnesses, prepares a
  release record, may push a release commit and tags to `main`, persists the
  archive, and publishes it.
- The workflow does not have a job that runs the root `pnpm verify` command.
- The workflow does not run `pnpm verify:consumers`.
- The local `release:preflight` currently supplies broader checks before
  `push:release` changes the remote release path.
- Candidate artifacts currently have a finite retention period.

These observations must be refreshed against the exact implementation
candidate before a final gate.

## Competing Alternatives

### A. Retain mandatory local container preflight

Continue validating locally before pushing `main`, then repeat platform and
publication work in Actions.

- Strength: catches failures before any remote mutation and provides a local
  Linux reproduction environment.
- Weakness: duplicates CI work, blocks the operator, depends on local container
  runtime behavior, and still does not make the remote control plane complete
  by construction.

### B. Remove local preflight but keep push-to-main release

Add missing checks to the existing workflow while allowing the source SHA to
enter `main` before they complete.

- Strength: smallest workflow edit.
- Weakness: creates a period where `main` contains an unverified release source;
  rollback or follow-up repair becomes part of the safety model.

### C. Validate candidate ref, then promote exact SHA

Run the complete witness DAG on a candidate ref and fast-forward `main` only
after success.

- Strength: closes the unverified-main window and removes local heavy gates.
- Weakness: requires branch protection, serialized promotion, durable artifact
  identity, and a privilege boundary between validation and promotion.

### D. Continuously witness every eligible candidate SHA

Use C, but start the complete release witness on each eligible final candidate
push so release intent only promotes and publishes an existing witness.

- Strength: minimizes release-intent latency.
- Weakness: consumes more Actions capacity, can build artifacts never released,
  and requires an explicit policy for witness expiry and stale candidates.

### E. Dedicated self-hosted Actions runners

Use C or D with persistent or ephemeral self-hosted runners.

- Strength: may reduce queue, checkout, and install latency.
- Weakness: adds runner isolation, credential, cleanup, availability, and
  maintenance responsibilities. Persistent runners can leak state between
  candidate executions.

## Known Weaknesses

1. GitHub Actions availability and queue latency become release-path
   dependencies.
2. A privileged `workflow_run`-style promoter is dangerous if it checks out or
   executes candidate-controlled code, trusts artifact names without digest
   binding, or accepts a result from the wrong workflow or repository context.
3. Fast-forward promotion is insufficient if another supported path can push
   directly to `main` or create release tags.
4. Finite artifact retention conflicts with indefinite reuse of a previously
   witnessed release candidate.
5. A release-record commit created after validation has a different SHA from
   the witnessed source. The design must distinguish source SHA, release-record
   SHA, tag target, and published archive identity without claiming they are one
   value.
6. Cancellation and concurrency rules can cancel a valid candidate, promote a
   stale candidate, or interleave irreversible publication unless promotion and
   publication have explicit serialization semantics.
7. Aggressive affected-package selection can omit a required witness when root
   tooling, shared contracts, lockfile state, generated assets, or transitive
   consumers change.
8. Splitting checks into too many jobs may increase wall time because each job
   repeats queueing, checkout, setup, and installation.
9. Consumer and browser smoke tests may depend on services or hardware not
   faithfully represented on all GitHub-hosted runners.
10. Reusing caches must not turn mutable build output into evidence or weaken
    frozen-lockfile and archive-integrity verification.

## Required evidence before retention

1. A command-to-job coverage map proving every mandatory local preflight check
   has an authoritative CI owner or is explicitly removed with justification.
2. A source/archive identity model covering source SHA, release-record commit,
   tag, candidate manifest, artifact digest, npm integrity, and registry
   acceptance.
3. Repository rules or equivalent enforcement showing that supported writes to
   `main` and release tags pass through the promoter.
4. A threat analysis for unprivileged validation versus privileged promotion,
   including artifact retrieval and metadata validation.
5. A concurrency model for multiple candidate SHAs, retries, cancellation,
   partial publish, and movement of `main`.
6. A retention model defining when a witness expires and whether the archive is
   persisted to a durable immutable location before promotion/publication.
7. Measured Actions step timings showing whether job sharding, combining, or
   runner changes reduce the actual critical path.
8. Tests that attempt direct-main release, digest substitution, wrong-run
   artifact reuse, stale promotion, rebuild-before-publish, and missing witness
   promotion, and observe fail-closed behavior.

## Abandon Conditions

Abandon the CI-only proposal if any of these remain true:

1. The repository cannot prevent supported direct writes to `main` or release
   tags that bypass the witness gate.
2. The promoter must execute candidate-controlled code while holding write or
   publication authority.
3. The publication path cannot consume the exact archive witnessed by all
   required jobs.
4. Required release checks cannot run reliably in GitHub Actions and no
   equivalent remote witness is available.
5. The organization requires release capability during GitHub Actions outages
   and accepts neither delayed release nor a separately audited emergency path.

## Evidence That Would Change Our Mind

- If measured Actions queue plus execution latency is consistently worse than
  the local preflight and release urgency requires synchronous completion,
  retain remote gating but reconsider continuous witnesses or runner capacity.
- If branch rules and promoter credentials cannot enforce exclusive promotion,
  retain mandatory local checks only as mitigation while redesigning the remote
  ownership boundary; do not claim the class is closed.
- If continuous witnesses consume disproportionate capacity relative to actual
  releases, choose on-demand candidate-ref validation instead of D.
- If a dedicated ephemeral runner materially shortens the measured critical
  path without introducing persistent trust state, reconsider E.
- If release-record mutation cannot be separated from the witnessed source and
  archive identities, revise the release-record model before removing the local
  gate.

## Review Questions

1. Does candidate-ref validation plus privileged promotion actually close the
   unverified-main failure class under the current GitHub permission model?
2. Can release-record creation preserve the distinction between witnessed
   source identity and the later release metadata commit?
3. Is continuous witnessing justified, or does on-demand candidate validation
   dominate after Actions cost and candidate frequency are measured?
4. Which checks are safe to parallelize without introducing a second build or
   a second source of candidate truth?
5. What is the strongest viable alternative if exclusive promotion cannot be
   enforced?

## Initial Recommendation

Prefer C as the safety architecture. Add D only for branches or explicit
candidate refs likely to be released. Do not make E part of the release
contract; use hosted runners first and introduce ephemeral self-hosted capacity
only after measurements identify queue or runner speed as the dominant cost.


## Exact candidate proposal
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



## Projected disposition ledger
{
  "ok": true,
  "decision_work_dir": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0",
  "decision_id": "ci-only-release-20260718-162536-d5f51ef0",
  "state": "DECIDED",
  "dossier_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/dossier.md",
  "dossier_sha256": "3009112445990c651dfa27b733f9f622ec2a648d86cdc6c0b10d1911a28d7254",
  "current_proposal_revision": "P2",
  "current_proposal_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/proposals/P2.md",
  "current_proposal_sha256": "70c279e3f94663bfebb22ba086a36d8c094c96244f2fea05d510b1500fb8b19e",
  "challenge": {
    "at": 1784363576.4603379,
    "findings": [
      {
        "causal_boundary": "True for the release.yml + candidate-pipeline.mjs + container-preflight.mjs + workflow.test.mjs at dossier creation. It judges the current implementation and the sequencing of removal, NOT the proposal's target design (proposal step 3 does include consumer/Chrome witnesses). The gap is that those witnesses are not yet built.",
        "claim": "In the dossier-time implementation candidate, verify:consumers, Chrome release:check, and the test:release + verify:packages portions of root `pnpm verify` (which for web includes ci:verify/e2e) live ONLY in the local container preflight and are deliberately, test-enforcedly excluded from release.yml. Removing local preflight without first adding authoritative CI owners drops these checks from every supported release path, violating Criterion 3 and the invariant that all preflight checks remain represented in CI.",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "3",
        "evidence": [
          ".github/workflows/release.yml:50-53 candidate job runs `candidate-pipeline.mjs verify-release-source` only",
          "tooling/release/candidate-pipeline.mjs:17-21 verifyReleaseSource runs only `pnpm release:verify-source`",
          "package.json:19 release:verify-source == `pnpm run check:workspace` (no test:release, no verify:packages)",
          "package.json:27,31 root `verify`=check:workspace \u0026\u0026 test:release \u0026\u0026 verify:packages; consumers/chrome only in release:verify + preflight",
          "tooling/release/candidate-pipeline.mjs:48-55 local `full` runs pnpm verify + verifyCandidate + verifyConsumers",
          "tooling/release/container-preflight.mjs:29 runs pi-chrome release:check; :96 runs candidate-pipeline full",
          "tooling/release/workflow.test.mjs:124-125 asserts candidate job has no `pnpm verify` and no `release:check`; :158-166 asserts workflow does NOT contain verify:consumers",
          "Grep .github: only verify:platform, verify:candidates, verify:registry are present in the workflow"
        ],
        "falsifier": "A refreshed implementation candidate whose workflow assigns authoritative CI jobs to verify:consumers, chrome candidate/smoke, test:release and verify:packages (with the workflow.test.mjs prohibitions inverted), evidenced by the required command-to-job coverage map (Required Evidence #1).",
        "id": "F1",
        "severity": "invariant",
        "violated_invariant": "Criterion 3 / All checks currently supplied by local preflight remain represented in CI (pnpm verify, consumer verification, Chrome candidate/smoke)"
      },
      {
        "causal_boundary": "Property of verify-consumers.mjs, web ci:verify, and pi-chrome release:check as currently authored; becomes a blocker only if these cannot be reproduced faithfully on hosted runners. No runner-fidelity measurement (Required Evidence #7) is present.",
        "claim": "The checks that must migrate include browser/SSE/CLI consumer smoke and web e2e, which today run on the operator's macOS host and a local Linux container. Their faithful execution on GitHub-hosted ubuntu/macos/windows runners (browsers, services, ports, hardware) is unproven, so the coverage-map closure in F1 is a re-architecture that can hit Abandon Condition #4 (required checks cannot run reliably in Actions), not a one-line addition.",
        "claim_type": "fact",
        "confidence": "medium",
        "criterion_id": "3",
        "evidence": [
          "tooling/release/verify-consumers.mjs:40-50 web archive browser/sse/cli/health/page smoke",
          "tooling/release/verify-consumers.mjs:52-102 combined npm+pnpm real install of archives",
          "tooling/release/workflow.test.mjs:182-185 web ci:verify runs `pnpm test:e2e:run`",
          "tooling/release/container-preflight.mjs:15 preflight asserts darwin (Apple container) host; Chrome release:check runs on host at :29"
        ],
        "falsifier": "Measured green runs of consumer smoke, web e2e, and Chrome release:check on the intended hosted runners, plus evidence the required browsers/services/ports are faithfully available (Required Evidence #7).",
        "id": "F2",
        "severity": "high",
        "violated_invariant": null
      },
      {
        "causal_boundary": "Describes the release.yml publish job as-is. The vulnerability materializes only under the candidate-ref model if promotion/publication are not split from candidate-code execution; it is not a live exploit in the current push-to-main flow.",
        "claim": "The current publish job executes candidate-controlled code (root `prepare` lifecycle on install, prepare.mjs, verify-prepared-candidate.mjs, pnpm verify:candidates, create-release-record.mjs, pnpm publish:candidates) while holding contents:write + id-token:write and pushing HEAD:main. This is acceptable today because the SHA is already on main (push-to-main model), but it is structurally incompatible with proposal C, whose promoter must verify the witness set WITHOUT executing candidate code. Implementing C by retargeting this job at an unmerged candidate ref would re-open the exact failure class (Criterion 5 / Abandon Condition #2).",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "5",
        "evidence": [
          ".github/workflows/release.yml:144-146 publish permissions contents:write + id-token:write",
          ".github/workflows/release.yml:157 pnpm install runs root `prepare` (package.json:15 effect-tsgo patch)",
          ".github/workflows/release.yml:167-172 runs prepare.mjs, verify-prepared-candidate.mjs, pnpm verify:candidates",
          ".github/workflows/release.yml:176-181 create-release-record.mjs then `git push --atomic origin HEAD:main $tags`",
          ".github/workflows/release.yml:201 pnpm publish:candidates under OIDC; all tooling/release/*.mjs are checked out at github.sha"
        ],
        "falsifier": "An implementation where a privileged promoter with no dependency install and no candidate-authored code verifies the witness set and fast-forwards main, and publication consumes only pre-witnessed archive bytes through a boundary that never grants candidate code write/OIDC authority (Required Evidence #4).",
        "id": "F3",
        "severity": "high",
        "violated_invariant": "Proposal step 4 / Abandon Condition #2: the promoter must not execute candidate-controlled code while holding write or publication authority"
      },
      {
        "causal_boundary": "Statement about in-tree evidence only. It does NOT assert server-side branch protection is absent (it may exist); it asserts the exclusivity guarantee is not demonstrable from the repository and must be produced as Required Evidence #3.",
        "claim": "Exclusive-promoter enforcement is unverifiable from the repository: `.github` contains only release.yml, with no ruleset-as-code, CODEOWNERS, or branch-protection config in tree. Assumption #3 and Required Evidence #3 are therefore undischarged from available evidence, and Abandon Condition #1 (repo cannot prevent supported direct writes to main/tags) cannot be closed here. Fast-forward promotion is insufficient if any other supported path can push to main or create release tags (Known Weakness #3).",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "1",
        "evidence": [
          "Glob .github/**/* returns only .github/workflows/release.yml (no ruleset/CODEOWNERS/branch-protection files)",
          "Glob for CODEOWNERS/ruleset/branch-protection finds only node_modules third-party files",
          "push-release.mjs:20 and release.yml:181 both perform `git push` to main from different identities, implying reliance on unseen server-side rules"
        ],
        "falsifier": "GitHub repository rules/branch protection showing every supported write to main and to release tags passes only through the promoter identity, plus a fail-closed test that attempts a direct-main push and a rogue tag and observes rejection (Required Evidence #3 + #8).",
        "id": "F4",
        "severity": "high",
        "violated_invariant": "Criterion 1 / Abandon Condition #1: only witnessed SHAs may reach main; no supported path may bypass the promoter"
      },
      {
        "causal_boundary": "Current publish flow. The record is a deterministic derivation re-checked by classify.mjs, so it is managed today; the risk is that the CI-only cutover conflates 'witnessed source' with 'what lands on main' unless the record model is redefined.",
        "claim": "The publish job creates a NEW release-record commit (bumped versions) and pushes it to main — a SHA never covered by the candidate/platform witness DAG. Proposal step 4 says main is fast-forwarded to the exact witnessed source SHA, which is in direct tension with advancing main to an unwitnessed release-record commit. The design must keep source SHA, release-record SHA, tag target, and archive digest as distinct-but-bound identities before the local gate is removed.",
        "claim_type": "tradeoff",
        "confidence": "high",
        "criterion_id": "9",
        "evidence": [
          ".github/workflows/release.yml:173-181 create-release-record.mjs creates a distinct commit pushed to main",
          "tooling/release/prepare.mjs:88-101 writes bumped package versions into the release set",
          "tooling/release/classify.mjs:19-44 independently re-verifies release-record commits (derivation, not witnessed by candidate/platform jobs)"
        ],
        "falsifier": "A model that either creates the release-record commit before the witness DAG so it becomes the witnessed SHA, or proves via test that the record is a byte-deterministic verified derivation of the witnessed source such that no unwitnessed content reaches main (Evidence That Would Change Our Mind #5).",
        "id": "F5",
        "severity": "medium",
        "violated_invariant": "Known Weakness #5 / Review Question #2: witnessed source identity vs later release-metadata commit must stay distinct and bound"
      },
      {
        "causal_boundary": "release.yml retention and restore logic as written; applies to D's 'reuse an existing witness' claim. For plain C (validate on release request) the constraint is weaker because persistence-before-publish already writes a durable asset.",
        "claim": "The candidate run-artifact retention is 14 days, and the 'existing/prior' reuse path depends on either a durable gh release asset or a non-expired run artifact. The optimized continuous-witness form (D) reuses a witnessed archive for a not-yet-released candidate, for which no durable release asset exists yet; after 14 days its only copy expires, forcing a rebuild (new digest) and re-witness. This bounds D's latency benefit and requires an explicit durable-persistence + witness-expiry policy, reinforcing the initial recommendation to prefer on-demand candidate validation (C) over default D.",
        "claim_type": "tradeoff",
        "confidence": "medium",
        "criterion_id": "7",
        "evidence": [
          ".github/workflows/release.yml:111 candidate artifact `retention-days: 14`",
          ".github/workflows/release.yml:73-97 restore depends on durable gh release asset or non-expired prior run artifact",
          ".github/workflows/release.yml:182-200 durable persistence (gh release upload + cmp) only happens at publication time"
        ],
        "falsifier": "A retention model persisting every eligible witnessed candidate to a durable immutable location at witness time with a defined expiry, and a measurement showing D's saved latency exceeds the added storage/capacity cost (Required Evidence #6 + #7).",
        "id": "F6",
        "severity": "low",
        "violated_invariant": "Known Weakness #4: finite retention conflicts with indefinite reuse of a previously witnessed candidate"
      }
    ],
    "operation_work_dir": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/runs/challenge-20260718-162537.004652000",
    "proposal_revision": "P1",
    "proposal_sha256": "ed714fca50e8055e51b092c2930532a1c9b6c48128446fe7798a0199bf6a6aea",
    "recommendation": "revise",
    "strongest_alternative": "Retain Alternative A (mandatory local container preflight) as the sole authoritative gate for this change, and add the missing checks (verify:consumers, Chrome candidate/smoke, test:release, verify:packages) to CI incrementally WITHOUT removing local preflight — cutting over to CI-only only after every precondition is discharged. This is the strongest competitor to adopting the proposal now because F1 shows the remote plane does not currently own the consumer/Chrome/e2e checks (they are test-enforced OUT of the workflow), F3 shows the only privileged job still fuses promotion, publication, and candidate-code execution, and F4 shows exclusive-promoter enforcement is unverifiable in-tree. A's acknowledged weaknesses (duplicated work, operator blocking, dependence on local container runtime) are tolerable during a transition and are strictly safer than deleting the only owner of consumer/e2e/Chrome coverage before CI provably owns it.",
    "surviving_invariants": [
      "Architecture C (candidate-ref validation + a privileged promoter that fast-forwards main only after the complete witness set) is the correct target; the challenge does not falsify it, and with F1/F3/F4 preconditions met it does close the unverified-main class.",
      "Only an exact source SHA with a complete witness set may enter main; npm may receive only the exact witnessed archive bytes; no validation result may be reused across a different SHA or archive digest.",
      "Publication must consume the persisted, byte-identical witnessed archive without rebuild or repack (upheld today by release.yml:182-201 cmp/persist-before-publish and verify-prepared-candidate.mjs; same artifact downloaded by macOS/Windows witnesses).",
      "One release source SHA maps to one explicit public-package release set and one exact archive per selected package (Criterion 9).",
      "Source classification stays install-free and cannot gain credentials (classify job has no setup-node/pnpm install; workflow.test.mjs:174-179)."
    ],
    "type": "challenge_completed",
    "unknowns": [
      "Whether GitHub server-side branch protection/rulesets already make the promoter the exclusive writer to main and release tags (not representable in the repo tree).",
      "Whether hosted ubuntu/macos/windows runners faithfully run web `test:e2e:run`, consumer browser/sse/health/cli smoke, and pi-chrome `release:check` (Known Weakness #9; Required Evidence #7 absent).",
      "Measured Actions queue + execution latency versus the local preflight, and whether release urgency requires synchronous completion (Required Evidence #7).",
      "Whether `concurrency.queue: max` (release.yml:10, asserted at workflow.test.mjs:80) is an honored GitHub Actions key or silently ignored — if ignored, promotion serialization under concurrent SHAs / main movement (Criterion 4) may not hold as designed.",
      "The durable-persistence and witness-expiry policy for witnessed-but-unreleased candidates required to make D's reuse claim hold past the 14-day artifact retention (Required Evidence #6)."
    ]
  },
  "findings": {
    "F1": {
      "id": "F1",
      "finding": {
        "causal_boundary": "True for the release.yml + candidate-pipeline.mjs + container-preflight.mjs + workflow.test.mjs at dossier creation. It judges the current implementation and the sequencing of removal, NOT the proposal's target design (proposal step 3 does include consumer/Chrome witnesses). The gap is that those witnesses are not yet built.",
        "claim": "In the dossier-time implementation candidate, verify:consumers, Chrome release:check, and the test:release + verify:packages portions of root `pnpm verify` (which for web includes ci:verify/e2e) live ONLY in the local container preflight and are deliberately, test-enforcedly excluded from release.yml. Removing local preflight without first adding authoritative CI owners drops these checks from every supported release path, violating Criterion 3 and the invariant that all preflight checks remain represented in CI.",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "3",
        "evidence": [
          ".github/workflows/release.yml:50-53 candidate job runs `candidate-pipeline.mjs verify-release-source` only",
          "tooling/release/candidate-pipeline.mjs:17-21 verifyReleaseSource runs only `pnpm release:verify-source`",
          "package.json:19 release:verify-source == `pnpm run check:workspace` (no test:release, no verify:packages)",
          "package.json:27,31 root `verify`=check:workspace \u0026\u0026 test:release \u0026\u0026 verify:packages; consumers/chrome only in release:verify + preflight",
          "tooling/release/candidate-pipeline.mjs:48-55 local `full` runs pnpm verify + verifyCandidate + verifyConsumers",
          "tooling/release/container-preflight.mjs:29 runs pi-chrome release:check; :96 runs candidate-pipeline full",
          "tooling/release/workflow.test.mjs:124-125 asserts candidate job has no `pnpm verify` and no `release:check`; :158-166 asserts workflow does NOT contain verify:consumers",
          "Grep .github: only verify:platform, verify:candidates, verify:registry are present in the workflow"
        ],
        "falsifier": "A refreshed implementation candidate whose workflow assigns authoritative CI jobs to verify:consumers, chrome candidate/smoke, test:release and verify:packages (with the workflow.test.mjs prohibitions inverted), evidenced by the required command-to-job coverage map (Required Evidence #1).",
        "id": "F1",
        "severity": "invariant",
        "violated_invariant": "Criterion 3 / All checks currently supplied by local preflight remain represented in CI (pnpm verify, consumer verification, Chrome candidate/smoke)"
      },
      "disposition": {
        "at": 1784364114.795373,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E1-release-workflow",
          "E2-root-scripts",
          "E3-candidate-pipeline",
          "E4-container-preflight",
          "E5-workflow-contract-tests"
        ],
        "finding_id": "F1",
        "reason": "The current Actions path omits checks owned only by local preflight. Revision requires authoritative CI coverage and green hosted runs before local preflight is removed.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    },
    "F2": {
      "id": "F2",
      "finding": {
        "causal_boundary": "Property of verify-consumers.mjs, web ci:verify, and pi-chrome release:check as currently authored; becomes a blocker only if these cannot be reproduced faithfully on hosted runners. No runner-fidelity measurement (Required Evidence #7) is present.",
        "claim": "The checks that must migrate include browser/SSE/CLI consumer smoke and web e2e, which today run on the operator's macOS host and a local Linux container. Their faithful execution on GitHub-hosted ubuntu/macos/windows runners (browsers, services, ports, hardware) is unproven, so the coverage-map closure in F1 is a re-architecture that can hit Abandon Condition #4 (required checks cannot run reliably in Actions), not a one-line addition.",
        "claim_type": "fact",
        "confidence": "medium",
        "criterion_id": "3",
        "evidence": [
          "tooling/release/verify-consumers.mjs:40-50 web archive browser/sse/cli/health/page smoke",
          "tooling/release/verify-consumers.mjs:52-102 combined npm+pnpm real install of archives",
          "tooling/release/workflow.test.mjs:182-185 web ci:verify runs `pnpm test:e2e:run`",
          "tooling/release/container-preflight.mjs:15 preflight asserts darwin (Apple container) host; Chrome release:check runs on host at :29"
        ],
        "falsifier": "Measured green runs of consumer smoke, web e2e, and Chrome release:check on the intended hosted runners, plus evidence the required browsers/services/ports are faithfully available (Required Evidence #7).",
        "id": "F2",
        "severity": "high",
        "violated_invariant": null
      },
      "disposition": {
        "at": 1784364114.873324,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E4-container-preflight",
          "E6-consumer-verifier",
          "E7-web-ci",
          "E8-chrome-release"
        ],
        "finding_id": "F2",
        "reason": "Hosted-runner fidelity is not yet demonstrated. Revision makes successful hosted consumer, web e2e, and Chrome runs a cutover prerequisite while local preflight remains authoritative during migration.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    },
    "F3": {
      "id": "F3",
      "finding": {
        "causal_boundary": "Describes the release.yml publish job as-is. The vulnerability materializes only under the candidate-ref model if promotion/publication are not split from candidate-code execution; it is not a live exploit in the current push-to-main flow.",
        "claim": "The current publish job executes candidate-controlled code (root `prepare` lifecycle on install, prepare.mjs, verify-prepared-candidate.mjs, pnpm verify:candidates, create-release-record.mjs, pnpm publish:candidates) while holding contents:write + id-token:write and pushing HEAD:main. This is acceptable today because the SHA is already on main (push-to-main model), but it is structurally incompatible with proposal C, whose promoter must verify the witness set WITHOUT executing candidate code. Implementing C by retargeting this job at an unmerged candidate ref would re-open the exact failure class (Criterion 5 / Abandon Condition #2).",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "5",
        "evidence": [
          ".github/workflows/release.yml:144-146 publish permissions contents:write + id-token:write",
          ".github/workflows/release.yml:157 pnpm install runs root `prepare` (package.json:15 effect-tsgo patch)",
          ".github/workflows/release.yml:167-172 runs prepare.mjs, verify-prepared-candidate.mjs, pnpm verify:candidates",
          ".github/workflows/release.yml:176-181 create-release-record.mjs then `git push --atomic origin HEAD:main $tags`",
          ".github/workflows/release.yml:201 pnpm publish:candidates under OIDC; all tooling/release/*.mjs are checked out at github.sha"
        ],
        "falsifier": "An implementation where a privileged promoter with no dependency install and no candidate-authored code verifies the witness set and fast-forwards main, and publication consumes only pre-witnessed archive bytes through a boundary that never grants candidate code write/OIDC authority (Required Evidence #4).",
        "id": "F3",
        "severity": "high",
        "violated_invariant": "Proposal step 4 / Abandon Condition #2: the promoter must not execute candidate-controlled code while holding write or publication authority"
      },
      "disposition": {
        "at": 1784364114.935261,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E1-release-workflow"
        ],
        "finding_id": "F3",
        "reason": "The current privileged publish job executes candidate-controlled repository code. Revision splits validation from a no-checkout, no-install, no-candidate-code promoter/publisher that verifies exact run and archive identities.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    },
    "F4": {
      "id": "F4",
      "finding": {
        "causal_boundary": "Statement about in-tree evidence only. It does NOT assert server-side branch protection is absent (it may exist); it asserts the exclusivity guarantee is not demonstrable from the repository and must be produced as Required Evidence #3.",
        "claim": "Exclusive-promoter enforcement is unverifiable from the repository: `.github` contains only release.yml, with no ruleset-as-code, CODEOWNERS, or branch-protection config in tree. Assumption #3 and Required Evidence #3 are therefore undischarged from available evidence, and Abandon Condition #1 (repo cannot prevent supported direct writes to main/tags) cannot be closed here. Fast-forward promotion is insufficient if any other supported path can push to main or create release tags (Known Weakness #3).",
        "claim_type": "fact",
        "confidence": "high",
        "criterion_id": "1",
        "evidence": [
          "Glob .github/**/* returns only .github/workflows/release.yml (no ruleset/CODEOWNERS/branch-protection files)",
          "Glob for CODEOWNERS/ruleset/branch-protection finds only node_modules third-party files",
          "push-release.mjs:20 and release.yml:181 both perform `git push` to main from different identities, implying reliance on unseen server-side rules"
        ],
        "falsifier": "GitHub repository rules/branch protection showing every supported write to main and to release tags passes only through the promoter identity, plus a fail-closed test that attempts a direct-main push and a rogue tag and observes rejection (Required Evidence #3 + #8).",
        "id": "F4",
        "severity": "high",
        "violated_invariant": "Criterion 1 / Abandon Condition #1: only witnessed SHAs may reach main; no supported path may bypass the promoter"
      },
      "disposition": {
        "at": 1784364115.000292,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E11-push-release",
          "E12-github-enforcement"
        ],
        "finding_id": "F4",
        "reason": "Authenticated GitHub evidence confirms no ruleset and no main branch protection. Revision requires exclusive promoter rules plus negative direct-main and rogue-tag tests before cutover.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    },
    "F5": {
      "id": "F5",
      "finding": {
        "causal_boundary": "Current publish flow. The record is a deterministic derivation re-checked by classify.mjs, so it is managed today; the risk is that the CI-only cutover conflates 'witnessed source' with 'what lands on main' unless the record model is redefined.",
        "claim": "The publish job creates a NEW release-record commit (bumped versions) and pushes it to main — a SHA never covered by the candidate/platform witness DAG. Proposal step 4 says main is fast-forwarded to the exact witnessed source SHA, which is in direct tension with advancing main to an unwitnessed release-record commit. The design must keep source SHA, release-record SHA, tag target, and archive digest as distinct-but-bound identities before the local gate is removed.",
        "claim_type": "tradeoff",
        "confidence": "high",
        "criterion_id": "9",
        "evidence": [
          ".github/workflows/release.yml:173-181 create-release-record.mjs creates a distinct commit pushed to main",
          "tooling/release/prepare.mjs:88-101 writes bumped package versions into the release set",
          "tooling/release/classify.mjs:19-44 independently re-verifies release-record commits (derivation, not witnessed by candidate/platform jobs)"
        ],
        "falsifier": "A model that either creates the release-record commit before the witness DAG so it becomes the witnessed SHA, or proves via test that the record is a byte-deterministic verified derivation of the witnessed source such that no unwitnessed content reaches main (Evidence That Would Change Our Mind #5).",
        "id": "F5",
        "severity": "medium",
        "violated_invariant": "Known Weakness #5 / Review Question #2: witnessed source identity vs later release-metadata commit must stay distinct and bound"
      },
      "disposition": {
        "at": 1784364115.0632372,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E1-release-workflow",
          "E9-prepare",
          "E10-classifier"
        ],
        "finding_id": "F5",
        "reason": "The current post-witness release-record commit has a distinct unwitnessed SHA. Revision defines a release-candidate commit R before the witness DAG and promotes that exact witnessed R with no post-witness content commit.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    },
    "F6": {
      "id": "F6",
      "finding": {
        "causal_boundary": "release.yml retention and restore logic as written; applies to D's 'reuse an existing witness' claim. For plain C (validate on release request) the constraint is weaker because persistence-before-publish already writes a durable asset.",
        "claim": "The candidate run-artifact retention is 14 days, and the 'existing/prior' reuse path depends on either a durable gh release asset or a non-expired run artifact. The optimized continuous-witness form (D) reuses a witnessed archive for a not-yet-released candidate, for which no durable release asset exists yet; after 14 days its only copy expires, forcing a rebuild (new digest) and re-witness. This bounds D's latency benefit and requires an explicit durable-persistence + witness-expiry policy, reinforcing the initial recommendation to prefer on-demand candidate validation (C) over default D.",
        "claim_type": "tradeoff",
        "confidence": "medium",
        "criterion_id": "7",
        "evidence": [
          ".github/workflows/release.yml:111 candidate artifact `retention-days: 14`",
          ".github/workflows/release.yml:73-97 restore depends on durable gh release asset or non-expired prior run artifact",
          ".github/workflows/release.yml:182-200 durable persistence (gh release upload + cmp) only happens at publication time"
        ],
        "falsifier": "A retention model persisting every eligible witnessed candidate to a durable immutable location at witness time with a defined expiry, and a measurement showing D's saved latency exceeds the added storage/capacity cost (Required Evidence #6 + #7).",
        "id": "F6",
        "severity": "low",
        "violated_invariant": "Known Weakness #4: finite retention conflicts with indefinite reuse of a previously witnessed candidate"
      },
      "disposition": {
        "at": 1784364115.1283572,
        "authority": "",
        "decision_owner": "codex",
        "disposition": "accepted",
        "evidence_receipts": [
          "E1-release-workflow"
        ],
        "finding_id": "F6",
        "reason": "Fourteen-day run-artifact retention cannot support indefinite continuous witness reuse. Revision limits eager witnessing to explicit release candidates and defines durable digest-bound persistence plus witness expiry/garbage collection.",
        "type": "finding_dispositioned"
      },
      "resolved": true,
      "resolution": "accepted finding mapped to decision",
      "occurrences": 1
    }
  },
  "unresolved_finding_ids": [],
  "evidence": {
    "E1-release-workflow": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E1-release-workflow",
      "artifact_sha256": "fd6631fe09bb1fbad5b754311bb3095f9d25f09615757f097a80c61da4cea6d4",
      "artifact_size": 8511,
      "at": 1784364032.171277,
      "evidence_id": "E1-release-workflow",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/.github/workflows/release.yml",
      "summary": "Current GitHub release workflow, permissions, candidate artifact retention, platform witnesses, release-record push, and publication path.",
      "type": "evidence_observed"
    },
    "E10-classifier": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E10-classifier",
      "artifact_sha256": "f4e4d33b76063f2bb5ecc73e33c8829ba4424c6bed671e91a3e3f7afc61e4216",
      "artifact_size": 2241,
      "at": 1784364032.737647,
      "evidence_id": "E10-classifier",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/classify.mjs",
      "summary": "Release-record commits are separately classified and validated.",
      "type": "evidence_observed"
    },
    "E11-push-release": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E11-push-release",
      "artifact_sha256": "f050419fc51e097644fb4c97e9fe58d6ae4887069a53411f57cdc2bb1bf45bee",
      "artifact_size": 673,
      "at": 1784364032.802592,
      "evidence_id": "E11-push-release",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/push-release.mjs",
      "summary": "Current local preflight then direct push-to-main path.",
      "type": "evidence_observed"
    },
    "E12-github-enforcement": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E12-github-enforcement",
      "artifact_sha256": "0dc3386cfb874e16e98259d0c8874cf15794e7b5a67cc9d9795c7ba0fa07b9f8",
      "artifact_size": 1158,
      "at": 1784364032.8616052,
      "evidence_id": "E12-github-enforcement",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/github-enforcement-20260718.md",
      "summary": "Authenticated GitHub API observation: no repository rulesets and main is not branch protected.",
      "type": "evidence_observed"
    },
    "E2-root-scripts": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E2-root-scripts",
      "artifact_sha256": "b4df73e871ca9f9d9c6c4a9559e8bf19f2a754f46763a3851da92cd97d35be09",
      "artifact_size": 1939,
      "at": 1784364032.2417111,
      "evidence_id": "E2-root-scripts",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/package.json",
      "summary": "Root verification and release command ownership.",
      "type": "evidence_observed"
    },
    "E3-candidate-pipeline": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E3-candidate-pipeline",
      "artifact_sha256": "1aabe08bf238596f6c4695d7c4444f4e20b2c852d28499c73aa4a68bad8f2d6e",
      "artifact_size": 1600,
      "at": 1784364032.301638,
      "evidence_id": "E3-candidate-pipeline",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/candidate-pipeline.mjs",
      "summary": "Difference between narrow Actions source verification and full local preflight checks.",
      "type": "evidence_observed"
    },
    "E4-container-preflight": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E4-container-preflight",
      "artifact_sha256": "635f942dbb5d1f08ef00dc231dc05bcf5b17fdfd7ffdc980ab588dbfccddc840",
      "artifact_size": 4709,
      "at": 1784364032.362752,
      "evidence_id": "E4-container-preflight",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/container-preflight.mjs",
      "summary": "Current mandatory local Chrome and Linux full-preflight coverage.",
      "type": "evidence_observed"
    },
    "E5-workflow-contract-tests": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E5-workflow-contract-tests",
      "artifact_sha256": "679a4ff6a05697bca559765fb1b441f05b3d8b80ee3b27a1fbaf03f76d7a89a3",
      "artifact_size": 9989,
      "at": 1784364032.429614,
      "evidence_id": "E5-workflow-contract-tests",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/workflow.test.mjs",
      "summary": "Tests that deliberately exclude full verify, Chrome release check, and consumer verification from Actions.",
      "type": "evidence_observed"
    },
    "E6-consumer-verifier": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E6-consumer-verifier",
      "artifact_sha256": "3f8f30d9bf1dd6436c80a25f9c608398d216339a1860ea2e4749fefab9cfe95d",
      "artifact_size": 3131,
      "at": 1784364032.489574,
      "evidence_id": "E6-consumer-verifier",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/verify-consumers.mjs",
      "summary": "Browser, SSE, CLI, health, raw archive, npm, and pnpm consumer checks that must migrate.",
      "type": "evidence_observed"
    },
    "E7-web-ci": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E7-web-ci",
      "artifact_sha256": "ecf2351e62a80217d730bc76b63162ef590dbafaae1199bb3c65a38463438d6c",
      "artifact_size": 2574,
      "at": 1784364032.5506382,
      "evidence_id": "E7-web-ci",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/apps/web/vite.config.ts",
      "summary": "Pi Web CI verify includes e2e execution.",
      "type": "evidence_observed"
    },
    "E8-chrome-release": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E8-chrome-release",
      "artifact_sha256": "ca396b6f1eec35680ced9f3d810ccec11b2ed5f1751b0a065a9fbc0c72f1a3a5",
      "artifact_size": 3287,
      "at": 1784364032.616562,
      "evidence_id": "E8-chrome-release",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/extensions/chrome/package.json",
      "summary": "Chrome release check command is separately owned by the Chrome package.",
      "type": "evidence_observed"
    },
    "E9-prepare": {
      "artifact_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/evidence/E9-prepare",
      "artifact_sha256": "4f9413839e86cb50a5bdc63669431a307ca8335cbc09c759030f9d33d500cf40",
      "artifact_size": 5009,
      "at": 1784364032.677645,
      "evidence_id": "E9-prepare",
      "kind": "source",
      "source_path": "/Users/yansir/code/52/pi-suite/tooling/release/prepare.mjs",
      "summary": "Release preparation mutates selected package versions and binds source release metadata.",
      "type": "evidence_observed"
    }
  },
  "decision": {
    "addresses": [
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6"
    ],
    "at": 1784364247.799716,
    "outcome": "revise",
    "proposal_path": "/Users/yansir/code/52/pi-suite/docs/reviews/decision-audits/ci-only-release-20260718-162536-d5f51ef0/proposals/P2.md",
    "proposal_revision": "P2",
    "proposal_sha256": "70c279e3f94663bfebb22ba086a36d8c094c96244f2fea05d510b1500fb8b19e",
    "reason": "Architecture C survives, but safe cutover requires complete CI ownership, hosted-runner proof, a pre-witness release commit, exclusive server-side promotion, a no-candidate-code privileged publisher, and finite explicit-candidate witness retention.",
    "type": "decision_recorded"
  },
  "event_count": 21
}