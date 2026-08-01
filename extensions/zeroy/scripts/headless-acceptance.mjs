import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { externalCheckFailures } from "./headless-acceptance/external-check.mjs";
import { readToolLedger } from "./headless-acceptance/ledger.mjs";
import { withLoopbackNoProxy } from "./headless-acceptance/no-proxy.mjs";

for (const key of ["ZEROY_SITES", "ZEROY_ACCEPTANCE_SITE_ID", "ZEROY_ACCEPTANCE_MODEL"])
  assert(process.env[key], `${key} is required for headless acceptance.`);
const sites = JSON.parse(process.env.ZEROY_SITES);
const siteId = process.env.ZEROY_ACCEPTANCE_SITE_ID;
assert(
  Array.isArray(sites) && sites.some((site) => site?.siteId === siteId),
  "Selected zeroY site is not configured.",
);
const root = resolve(import.meta.dirname, "..");
const pi = resolve(root, "node_modules/.bin/pi");
const extension = resolve(root, "dist/pi/extension.js");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-remote-acceptance-"));
const sessions = resolve(temporary, "sessions");
const run = Date.now().toString(36);
const ref = `headless-${run}`;
const route = `headless-proof-${run}`;
const prompt = `Use only the four zeroY tools to build and verify one small remote WordPress addition on site ${siteId}. Do not use shell, filesystem, source code, database, SSH, or any other tool.

First discover the site rather than guessing: inspect sites, then the selected site, schema, active release, and the remote theme file list. Read one listed theme file using its path.

Use exactly one SiteDraft for all writes. Stage one harmless new theme CSS file whose name includes ${run}; use expectedHash null because it is new. From the remote ThemeSchema choose a document schema, then stage a new canonical document with ref ${ref}, explicit route ${route}, meaningful title/content, and every required template-content value. Add and publish a non-default-locale translation for that staged ref with every required writable field. Read the draft after staging. Commit it with the exact base release returned by that Draft. Then read the CSS file you staged through artifactFiles and run externalCheck on the active site. Do not treat a stage receipt as publication.`;
const files = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
};
const safeLedgerSummary = (entries) =>
  entries.map((entry) => {
    const input = entry.input;
    const scope =
      typeof input.resource === "string"
        ? `resource:${input.resource}`
        : typeof input.artifact === "string"
          ? `artifact:${input.artifact}`
          : typeof input.operation?.kind === "string"
            ? `operation:${input.operation.kind}`
            : "commit";
    const connectorError = entry.result?.payload?.error;
    const result =
      entry.result === null
        ? "missing"
        : entry.result.isError
          ? entry.result.text.includes("Validation failed")
            ? "tool-error:validation"
            : "tool-error:host"
          : typeof connectorError?.code === "string"
            ? `connector-error:${connectorError.code}`
            : "ok";
    return { tool: entry.name, scope, result };
  });

try {
  const child = spawn(
    pi,
    [
      "--model",
      process.env.ZEROY_ACCEPTANCE_MODEL,
      "--mode",
      "json",
      "--print",
      "--no-builtin-tools",
      "--tools",
      "zeroy_inspect,zeroy_artifact_stage,zeroy_content_stage,zeroy_site_commit",
      "--extension",
      extension,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--session-dir",
      sessions,
      "--name",
      "zeroY remote SiteDraft acceptance",
      prompt,
    ],
    {
      cwd: temporary,
      env: withLoopbackNoProxy({ ...process.env, ZEROY_SITES: process.env.ZEROY_SITES }, sites),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // `--mode json --print` can emit a full provider response. The JSONL session
  // is the acceptance truth, so drain process output without retaining or
  // reporting model text; otherwise a full OS pipe can deadlock Pi after the
  // site has already completed its tool loop.
  child.stdout.resume();
  child.stderr.resume();
  let timedOut = false;
  const exit = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 600_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  const sessionFiles = await files(sessions);
  const events =
    sessionFiles.length === 1
      ? (await readFile(sessionFiles[0], "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const entries = readToolLedger(events);
  assert.equal(
    timedOut,
    false,
    `zeroY remote acceptance timed out; safe tool ledger: ${JSON.stringify(safeLedgerSummary(entries))}`,
  );
  assert.equal(
    exit,
    0,
    `zeroY remote acceptance Pi process failed; safe tool ledger: ${JSON.stringify(safeLedgerSummary(entries))}`,
  );
  assert.equal(sessionFiles.length, 1, "Pi did not write exactly one isolated session.");
  assert(entries.length > 0, "No zeroY tool calls were recorded.");
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of names)
    assert(
      [
        "zeroy_inspect",
        "zeroy_artifact_stage",
        "zeroy_content_stage",
        "zeroy_site_commit",
      ].includes(name),
      `Unknown tool ${name}.`,
    );
  for (const entry of entries) {
    assert(entry.input && Object.keys(entry.input).length > 0, `Empty input for ${entry.name}.`);
    assert(
      entry.result && !entry.result.isError,
      `Tool failed; safe tool ledger: ${JSON.stringify(safeLedgerSummary(entries))}`,
    );
    assert(
      !(entry.result.payload && typeof entry.result.payload.error === "object"),
      `Connector rejected ${entry.name}: ${entry.result.text}`,
    );
  }
  const inspections = entries.filter((entry) => entry.name === "zeroy_inspect");
  const resources = new Set(inspections.map((entry) => entry.input.resource));
  for (const resource of ["sites", "site", "schema", "release", "artifactFiles"])
    assert(resources.has(resource), `Inspect ${resource} was not exercised.`);
  assert(
    inspections.some(
      (entry) =>
        entry.input.resource === "artifactFiles" &&
        entry.input.artifact === "theme" &&
        !Object.prototype.hasOwnProperty.call(entry.input, "path"),
    ),
    "Remote theme file listing was not exercised.",
  );
  assert(
    inspections.some(
      (entry) =>
        entry.input.resource === "artifactFiles" &&
        entry.input.artifact === "theme" &&
        typeof entry.input.path === "string",
    ),
    "Remote theme file reading was not exercised.",
  );
  const artifactStages = entries.filter((entry) => entry.name === "zeroy_artifact_stage");
  const themeStages = artifactStages.filter((entry) => entry.input.artifact === "theme");
  assert(themeStages.length > 0, "Theme stage was not exercised.");
  const stagedThemeFiles = themeStages.flatMap((entry) => entry.input.files ?? []);
  assert(
    stagedThemeFiles.some(
      (file) =>
        typeof file?.path === "string" &&
        file.path.endsWith(".css") &&
        file.path.includes(run) &&
        file.expectedHash === null,
    ),
    "A new CSS ThemeArtifact file was not staged.",
  );
  const contentStages = entries.filter((entry) => entry.name === "zeroy_content_stage");
  assert(contentStages.length > 0, "Content stage was not exercised.");
  const stagedReceipts = [...artifactStages, ...contentStages].map(
    (entry) => entry.result?.payload,
  );
  assert(
    stagedReceipts.every((receipt) => typeof receipt?.draftId === "string"),
    "A stage receipt did not identify its SiteDraft.",
  );
  const stagedDraftIds = new Set(stagedReceipts.map((receipt) => receipt.draftId));
  assert.equal(
    stagedDraftIds.size,
    1,
    `Writes escaped one SiteDraft: ${JSON.stringify([...stagedDraftIds])}`,
  );
  const [draftId] = stagedDraftIds;
  assert(typeof draftId === "string", "The shared SiteDraft identity is missing.");
  const operations = contentStages.map((entry) => entry.input.operation);
  for (const kind of ["createCanonical", "writeTranslationDraft", "publishTranslation"])
    assert(
      operations.some((operation) => operation?.kind === kind),
      `${kind} was not staged.`,
    );
  const canonical = operations.find((operation) => operation?.kind === "createCanonical");
  assert.equal(canonical?.ref, ref, "Canonical ref was not preserved across the remote Draft.");
  assert.equal(canonical?.route, route, "Canonical public route was not explicit.");
  assert(
    typeof canonical?.postTitle === "string" && canonical.postTitle.length > 0,
    "Canonical postTitle is missing.",
  );
  const translations = operations.filter(
    (operation) =>
      operation?.kind === "writeTranslationDraft" || operation?.kind === "publishTranslation",
  );
  for (const operation of translations)
    assert.equal(
      operation.subject?.ref,
      ref,
      "Translation did not target the staged canonical ref.",
    );
  const commits = entries.filter((entry) => entry.name === "zeroy_site_commit");
  assert.equal(commits.length, 1, "Exactly one SiteDraft commit is required.");
  const [commit] = commits;
  assert.equal(commit.input.draftId, draftId, "Commit did not target the shared SiteDraft.");
  assert.equal(
    commit.input.expectedBaseReleaseId,
    stagedReceipts[0].baseReleaseId,
    "Commit did not use the SiteDraft's exact base release identity.",
  );
  assert.equal(
    commit.result?.payload?.draftId,
    draftId,
    "Activated SiteRelease does not bind the shared SiteDraft.",
  );
  assert(
    entries.some(
      (entry) =>
        entry.name === "zeroy_inspect" &&
        entry.input.resource === "artifactFiles" &&
        entry.input.artifact === "theme" &&
        typeof entry.input.path === "string" &&
        entry.input.path.includes(run),
    ),
    "The staged CSS file was not reread through the Connector.",
  );
  assert(
    entries.some(
      (entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck",
    ),
    "External check was not exercised.",
  );
  const external = entries.find(
    (entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck",
  )?.result?.payload?.externalCheck;
  assert(external && Array.isArray(external.pages), "External check did not return page evidence.");
  const externalFailures = externalCheckFailures(external.pages);
  assert.equal(
    externalFailures.length,
    0,
    `Published site failed external verification: ${JSON.stringify(externalFailures)}`,
  );
  process.stdout.write("zeroY remote SiteDraft headless acceptance passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
