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
