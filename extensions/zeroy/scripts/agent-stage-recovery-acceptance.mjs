import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { withLoopbackNoProxy } from "./headless-acceptance/no-proxy.mjs";
import { runHeadlessPi, safeToolLedgerSummary } from "./headless-acceptance/pi-runner.mjs";

for (const key of ["ZEROY_SITES", "ZEROY_ACCEPTANCE_SITE_ID", "ZEROY_ACCEPTANCE_MODEL"])
  assert(process.env[key], `${key} is required for Agent Stage recovery acceptance.`);

const sites = JSON.parse(process.env.ZEROY_SITES);
const siteId = process.env.ZEROY_ACCEPTANCE_SITE_ID;
assert(
  Array.isArray(sites) && sites.some((site) => site?.siteId === siteId),
  "Selected zeroY site is not configured.",
);

const root = resolve(import.meta.dirname, "..");
const pi = resolve(root, "node_modules/.bin/pi");
const extension = resolve(root, "dist/pi/extension.js");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-agent-stage-recovery-"));
const blockedSessions = resolve(temporary, "blocked-sessions");
const staleSessions = resolve(temporary, "stale-sessions");
const advancingSessions = resolve(temporary, "advancing-sessions");
const workspace = resolve(temporary, "empty-workspace");
await Promise.all(
  [blockedSessions, staleSessions, advancingSessions, workspace].map((path) => mkdir(path)),
);
const run = Date.now().toString(36);
const allowedTools = new Set([
  "zeroy_inspect",
  "zeroy_theme_stage",
  "zeroy_content_stage",
  "zeroy_site_commit",
]);
const environment = withLoopbackNoProxy(
  { ...process.env, ZEROY_SITES: process.env.ZEROY_SITES },
  sites,
);

const connectorErrorCode = (entry) =>
  typeof entry?.result?.payload?.error?.code === "string" ? entry.result.payload.error.code : null;
const nestedString = (value, key) => {
  if (typeof value !== "object" || value === null) return null;
  if (typeof value[key] === "string") return value[key];
  for (const child of Object.values(value)) {
    const found = nestedString(child, key);
    if (found !== null) return found;
  }
  return null;
};
const nestedArray = (value, key) => {
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = nestedArray(child, key);
    if (found !== null) return found;
  }
  return null;
};
const draftReceipt = (entry) => {
  const payload = entry?.result?.payload;
  return typeof payload?.draftId === "string"
    ? payload
    : typeof payload?.draft?.draftId === "string"
      ? payload.draft
      : null;
};
const assertClosedToolSurface = (entries, label) => {
  assert(entries.length > 0, `${label} recorded no zeroY tool calls.`);
  for (const entry of entries) {
    assert(allowedTools.has(entry.name), `${label} exposed unexpected tool ${entry.name}.`);
    assert(Object.keys(entry.input).length > 0, `${label} made an empty ${entry.name} call.`);
    assert(entry.result && !entry.result.isError, `${label} had a host tool failure.`);
  }
};
const successfulCommit = (entries) =>
  entries.find(
    (entry) =>
      entry.name === "zeroy_site_commit" &&
      entry.result?.payload?.state === "active" &&
      typeof entry.result.payload.releaseId === "string",
  );

try {
  const blockedPath = `__zeroy-agent-proof-block-${run}.php`;
  const blocked = await runHeadlessPi({
    pi,
    extension,
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: workspace,
    sessions: blockedSessions,
    name: "zeroY blocked CandidateProof recovery",
    env: environment,
    prompt: `Work only on zeroY site ${siteId} and use only the four zeroY tools. Never use local files, shell, source code, database, SSH, WP-CLI, or another tool.

Exercise and recover the public verification boundary. Discover the site and active release first. In one new SiteDraft, stage a temporary PHP theme file named ${blockedPath} whose complete source is: <?php file_put_contents(__DIR__ . '/forbidden.txt', 'blocked');

Attempt to commit that Draft. It must be rejected by CandidateProof. Read the returned structured data, inspect the exact proof through the public inspect surface, and repair the same Draft by deleting only that temporary file using the hash returned by its stage receipt. Commit the repaired Draft with its original base release. Inspect the activated release's complete proof and run externalCheck. In your final visible response, include exactly: "Proof scope: machine checks only; visual and business quality remain unproven."`,
  });
  assertClosedToolSurface(blocked.entries, "Blocked-proof session");
  const blockedCommit = blocked.entries.find(
    (entry) => connectorErrorCode(entry) === "zeroy_site_commit_proof_failed",
  );
  const blockedData = blockedCommit?.result?.payload?.error?.data;
  const blockedFailures = nestedArray(blockedData, "blockingFailures");
  assert(
    blockedCommit &&
      typeof blockedData?.draftId === "string" &&
      typeof blockedData?.proofId === "string" &&
      blockedFailures?.some((failure) => failure?.code === "theme_runtime_side_effect_forbidden"),
    `Blocked proof was not actionable: ${JSON.stringify(safeToolLedgerSummary(blocked.entries))}`,
  );
  assert(
    blocked.entries.some(
      (entry) =>
        entry.name === "zeroy_inspect" &&
        entry.input.resource === "proof" &&
        entry.input.proofId === blockedData.proofId &&
        entry.index > blockedCommit.index,
    ),
    "Agent did not inspect the blocked CandidateProof through the public proof surface.",
  );
  const blockedStages = blocked.entries.filter((entry) => entry.name === "zeroy_theme_stage");
  const createdBlockedFile = blockedStages.find((entry) =>
    entry.input.files?.some(
      (file) => file?.path === blockedPath && typeof file.content === "string",
    ),
  );
  const deletedBlockedFile = blockedStages.find((entry) =>
    entry.input.files?.some(
      (file) =>
        file?.path === blockedPath &&
        file.content === null &&
        typeof file.expectedHash === "string",
    ),
  );
  const repairedCommit = successfulCommit(blocked.entries);
  assert(createdBlockedFile && deletedBlockedFile, "Agent did not repair the blocked theme file.");
  assert.equal(
    draftReceipt(createdBlockedFile)?.draftId,
    draftReceipt(deletedBlockedFile)?.draftId,
    "Agent abandoned the blocked Draft instead of repairing it.",
  );
  assert.equal(
    repairedCommit?.input.draftId,
    draftReceipt(createdBlockedFile)?.draftId,
    "Agent did not activate the repaired Draft.",
  );
  const repairedProofId = nestedString(repairedCommit?.result?.payload, "proofId");
  assert(
    blocked.entries.some(
      (entry) =>
        entry.name === "zeroy_inspect" &&
        entry.input.resource === "proof" &&
        entry.input.proofId === repairedProofId,
    ),
    "Agent did not inspect the activated repaired proof.",
  );
  assert(
    blocked.entries.some(
      (entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck",
    ),
    "Agent did not run externalCheck after repairing CandidateProof.",
  );
  assert(
    blocked.visibleText.includes(
      "Proof scope: machine checks only; visual and business quality remain unproven.",
    ),
    "Agent final response overstated or omitted CandidateProof scope.",
  );

  const stalePath = `__zeroy-agent-stale-${run}.css`;
  const staleInitial = await runHeadlessPi({
    pi,
    extension,
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: workspace,
    sessions: staleSessions,
    name: "zeroY stale Draft owner",
    env: environment,
    prompt: `Work only on zeroY site ${siteId} and use only the four zeroY tools. Never use local files, shell, source code, database, SSH, WP-CLI, or another tool. Discover the current active release. Create one new SiteDraft by staging a harmless new CSS file named ${stalePath} containing only a comment. Inspect that Draft and stop without committing it. Preserve the returned Draft and base release identities for the next turn.`,
  });
  assertClosedToolSurface(staleInitial.entries, "Stale Draft initial session");
  assert.equal(
    staleInitial.entries.filter((entry) => entry.name === "zeroy_site_commit").length,
    0,
    "Stale Draft session committed before the concurrent advance.",
  );
  const staleStage = staleInitial.entries.find((entry) => entry.name === "zeroy_theme_stage");
  const staleReceipt = draftReceipt(staleStage);
  assert(staleReceipt, "Stale Draft session did not create a SiteDraft.");
  const staleInspection = staleInitial.entries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "draft" &&
      entry.input.draftId === staleReceipt.draftId,
  );
  const staleOperationsHash = nestedString(staleInspection?.result?.payload, "operationsHash");
  assert(typeof staleOperationsHash === "string", "Stale Draft inspection lost operationsHash.");

  const advancingPath = `__zeroy-agent-advance-${run}.css`;
  const advancing = await runHeadlessPi({
    pi,
    extension,
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: workspace,
    sessions: advancingSessions,
    name: "zeroY concurrent release advance",
    env: environment,
    prompt: `Work only on zeroY site ${siteId} and use only the four zeroY tools. Never use local files, shell, source code, database, SSH, WP-CLI, or another tool. Discover the active release, create a new SiteDraft containing one harmless new CSS file named ${advancingPath}, inspect the Draft, commit it with its exact base release, and inspect the new active release.`,
  });
  assertClosedToolSurface(advancing.entries, "Concurrent advance session");
  const advancingCommit = successfulCommit(advancing.entries);
  const advancingReleaseId = nestedString(advancingCommit?.result?.payload, "releaseId");
  assert(typeof advancingReleaseId === "string", "Concurrent session did not activate a release.");

  const resumed = await runHeadlessPi({
    pi,
    extension,
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: workspace,
    sessions: staleSessions,
    session: staleInitial.sessionFile,
    env: environment,
    prompt: `Continue the unfinished remote SiteDraft from this session. First attempt to commit that exact Draft with the base release identity previously returned; another session has advanced the site, so do not preemptively discard or replace it. Read the structured rejection and recover only through the public zeroY tools. Preserve the complete original operation log, inspect both the source and recovered Drafts, commit the recovered Draft against the current active release, inspect its complete CandidateProof, and run externalCheck. Do not use local files, shell, source code, database, SSH, WP-CLI, or another tool.`,
  });
  assertClosedToolSurface(resumed.entries, "Resumed stale Draft session");
  const resumedNewEntries = resumed.entries.slice(staleInitial.entries.length);
  const staleCommit = resumedNewEntries.find(
    (entry) => connectorErrorCode(entry) === "zeroy_site_draft_base_changed",
  );
  const staleData = staleCommit?.result?.payload?.error?.data;
  assert(
    staleCommit &&
      staleCommit.input.draftId === staleReceipt.draftId &&
      staleData?.baseReleaseId === staleReceipt.baseReleaseId &&
      staleData?.activeReleaseId === advancingReleaseId,
    `Agent did not observe exact stale-base facts: ${JSON.stringify(safeToolLedgerSummary(resumedNewEntries))}`,
  );
  const replay = resumedNewEntries.find(
    (entry) =>
      entry.name === "zeroy_content_stage" && entry.input.operation?.kind === "replayDraft",
  );
  const replayReceipt = draftReceipt(replay);
  assert(
    replay &&
      !("draftId" in replay.input) &&
      replay.input.operation.sourceDraftId === staleReceipt.draftId &&
      replayReceipt?.replayedFromDraftId === staleReceipt.draftId &&
      replayReceipt?.baseReleaseId === advancingReleaseId,
    "Agent did not recover the stale Draft through one explicit replay.",
  );
  const sourceAfterReplay = resumedNewEntries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "draft" &&
      entry.input.draftId === staleReceipt.draftId,
  );
  const replayAfterCreation = resumedNewEntries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "draft" &&
      entry.input.draftId === replayReceipt?.draftId,
  );
  assert.equal(nestedString(sourceAfterReplay?.result?.payload, "state"), "replayed");
  assert.equal(
    nestedString(sourceAfterReplay?.result?.payload, "operationsHash"),
    staleOperationsHash,
    "Replay changed the source Draft operation log.",
  );
  assert.equal(nestedString(replayAfterCreation?.result?.payload, "state"), "open");
  assert.equal(
    nestedString(replayAfterCreation?.result?.payload, "operationsHash"),
    staleOperationsHash,
    "Replay did not preserve the complete operation log.",
  );
  const replayCommit = resumedNewEntries.find(
    (entry) =>
      entry.name === "zeroy_site_commit" &&
      entry.input.draftId === replayReceipt?.draftId &&
      entry.result?.payload?.state === "active",
  );
  assert.equal(
    replayCommit?.input.expectedBaseReleaseId,
    advancingReleaseId,
    "Replayed Draft commit did not use the exact current active release.",
  );
  const replayProofId = nestedString(replayCommit?.result?.payload, "proofId");
  const replayProof = resumedNewEntries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "proof" &&
      entry.input.proofId === replayProofId,
  );
  assert.deepEqual(
    nestedArray(replayProof?.result?.payload, "blockingFailures"),
    [],
    "Replayed release did not expose a green CandidateProof.",
  );
  assert(
    resumedNewEntries.some(
      (entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck",
    ),
    "Replayed release did not receive an externalCheck.",
  );
  process.stdout.write("zeroY real-model Agent Stage recovery acceptance passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
