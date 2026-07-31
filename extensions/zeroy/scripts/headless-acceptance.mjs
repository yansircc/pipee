import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readToolLedger, recordValue } from "./headless-acceptance/ledger.mjs";

const required = ["ZEROY_SITES", "ZEROY_ACCEPTANCE_SITE_ID", "ZEROY_ACCEPTANCE_MODEL"];
for (const key of required) assert(process.env[key], `${key} is required for headless acceptance.`);
const configuredSites = JSON.parse(process.env.ZEROY_SITES);
const selectedSiteId = process.env.ZEROY_ACCEPTANCE_SITE_ID;
assert(
  Array.isArray(configuredSites) && configuredSites.some((site) => site?.siteId === selectedSiteId),
  "ZEROY_ACCEPTANCE_SITE_ID must name one configured zeroY site.",
);

const packageRoot = resolve(import.meta.dirname, "..");
const pi = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "dist/pi/extension.js");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-translation-acceptance-"));
const sessionDirectory = resolve(temporary, "sessions");
const token = `translation-${Date.now().toString(36)}`;
const prompt = `You are validating the zeroY Connector. Do not inspect extension source code, use shell tools, or use the local filesystem. First inspect configured sites and the selected site's ThemeSchema. Use configured site ${selectedSiteId}. Create a meaningful showcase page named "${token}". If its ThemeSchema declares template content, read that canonical projection and write useful source copy before translating. Then derive the English translation job for that exact page and create its English draft using only its writable fields. Use zeroY's same-origin external check to validate the returned draft preview URL, then publish using the draft receipt revision. Use the same external check to validate both public language versions. Next change exactly one canonical template text field, read the translation job again, repair only the stale English field, publish it, and report the two final public URLs.`;

const inspectResources = new Set([
  "sites",
  "site",
  "schema",
  "inventory",
  "acf",
  "canonicalContent",
  "adoptionCandidates",
  "existingPost",
  "themeState",
  "themeArtifact",
  "translationJob",
  "integrity",
  "externalCheck",
]);
const contentActions = new Set([
  "siteConfig",
  "createCanonical",
  "adoptCanonical",
  "assignSchema",
  "writeTemplateContent",
  "writeTranslationDraft",
  "publishTranslation",
  "unpublishTranslation",
]);
const payload = (entry) => recordValue(entry.result?.payload);
const action = (entry, value) =>
  entry.name === "zeroy_content_apply" && entry.input?.action === value;
const resource = (entry, value) =>
  entry.name === "zeroy_inspect" && entry.input?.resource === value;
const sessionFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(path)));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
};

const assertLedger = (events, output) => {
  const entries = readToolLedger(events);
  assert(entries.length > 0, "Pi session contains no tool calls.");
  for (const entry of entries) {
    assert(entry.name.startsWith("zeroy_"), `Forbidden non-zeroY tool call: ${entry.name}.`);
    assert(
      entry.input !== null && Object.keys(entry.input).length > 0,
      "Agent made an empty tool probe.",
    );
    assert(entry.result !== null && !entry.result.isError, `Tool call ${entry.name} failed.`);
    if (entry.name === "zeroy_inspect") {
      assert(
        inspectResources.has(entry.input.resource),
        `Unknown inspect resource ${entry.input.resource}.`,
      );
    }
    if (entry.name === "zeroy_content_apply") {
      assert(
        contentActions.has(entry.input.action),
        `Unknown content action ${entry.input.action}.`,
      );
    }
  }
  assert(!output.includes("Validation failed"), output);
  assert(!entries.some((entry) => resource(entry, "acf")), "Ordinary translation read raw ACF.");
  assert(
    !entries.some((entry) => entry.input?.resource === "contentTree"),
    "Ordinary translation read raw contentTree.",
  );
  assert(
    !entries.some(
      (entry) => entry.input?.action === "writeDraft" || entry.input?.action === "publish",
    ),
    "Legacy locale mutation is forbidden.",
  );

  const create = entries.find((entry) => action(entry, "createCanonical"));
  assert(
    typeof create?.input?.postTitle === "string" && create.input.postTitle.trim() !== "",
    "Canonical creation omitted the WordPress title.",
  );

  const drafts = entries.filter((entry) => action(entry, "writeTranslationDraft"));
  assert(drafts.length >= 2, "Agent did not create and then repair a Translation draft.");
  assert.equal(
    drafts[0]?.input?.expectedRevision,
    0,
    "First LocaleOverlay write must use revision 0.",
  );
  const draftReceipts = drafts.map((entry) => payload(entry));
  for (const receipt of draftReceipts) {
    assert(
      typeof receipt?.revision === "number",
      "Translation draft did not return a compact revision receipt.",
    );
    assert(
      typeof receipt?.previewUrl === "string",
      "Translation draft did not return a preview URL.",
    );
    assert(
      JSON.stringify(receipt).length < 4_000,
      "Translation receipt echoed an oversized document.",
    );
    assert(
      !Object.hasOwn(receipt, "document") && !Object.hasOwn(receipt, "contentTree"),
      "Translation receipt echoed a document.",
    );
  }

  const previewUrls = new Set(draftReceipts.map((receipt) => receipt.previewUrl));
  const externalChecks = entries.filter((entry) => resource(entry, "externalCheck"));
  const externallyRequestedUrls = new Set(
    externalChecks.flatMap((entry) => (Array.isArray(entry.input?.urls) ? entry.input.urls : [])),
  );
  for (const url of previewUrls) {
    assert(externallyRequestedUrls.has(url), `Draft preview was not checked: ${url}`);
  }

  const publishes = entries.filter((entry) => action(entry, "publishTranslation"));
  assert(publishes.length >= 2, "Agent did not publish the initial and repaired Translation.");
  let latestDraftRevision = null;
  for (const entry of entries) {
    if (action(entry, "writeTranslationDraft"))
      latestDraftRevision = payload(entry)?.revision ?? null;
    if (action(entry, "publishTranslation")) {
      assert.equal(
        entry.input.expectedRevision,
        latestDraftRevision,
        "Publish did not use the preceding draft receipt revision.",
      );
    }
  }
  const publishedUrls = publishes
    .map((entry) => payload(entry)?.url)
    .filter((url) => typeof url === "string");
  assert(publishedUrls.length >= 2, "Published receipts did not return public locale URLs.");
  const externallyCheckedUrls = new Set(
    externalChecks.flatMap((entry) => {
      const check = recordValue(payload(entry)?.externalCheck);
      return Array.isArray(check?.pages)
        ? check.pages.map((page) => recordValue(page)?.url).filter((url) => typeof url === "string")
        : [];
    }),
  );
  for (const url of publishedUrls) {
    assert(externallyCheckedUrls.has(url), `Published route was not checked: ${url}`);
  }
  const canonicalId = payload(create)?.objectId;
  const checkedLocales = new Set(
    externalChecks.flatMap((entry) => {
      const check = recordValue(payload(entry)?.externalCheck);
      return Array.isArray(check?.pages)
        ? check.pages
            .map(recordValue)
            .filter((page) => page?.objectId === canonicalId && page.status === 200)
            .map((page) => page.locale)
            .filter((locale) => typeof locale === "string")
        : [];
    }),
  );
  assert(checkedLocales.size >= 2, "Both published language routes were not externally checked.");

  const jobs = entries
    .filter((entry) => resource(entry, "translationJob"))
    .map((entry) => ({ index: entry.index, payload: payload(entry) }))
    .filter((entry) => entry.payload !== null);
  for (const job of jobs) {
    assert(
      JSON.stringify(job.payload).length < 24_000,
      "TranslationJob exceeded the Agent context budget.",
    );
  }
  const staleJob = jobs.find(({ payload: job }) => {
    const fields = Array.isArray(job.fields) ? job.fields.map(recordValue).filter(Boolean) : [];
    return fields.filter((field) => field.status === "stale").length === 1;
  });
  assert(staleJob, "Canonical edit did not produce exactly one stale translation field.");
  const staleFields = new Set(
    staleJob.payload.fields
      .map(recordValue)
      .filter((field) => field?.status === "stale")
      .map((field) => field.fieldId),
  );
  const repair = drafts.find((entry) => entry.index > staleJob.index);
  assert(repair, "Agent did not repair the stale TranslationJob.");
  assert.deepEqual(
    new Set(Object.keys(repair.input.values ?? {})),
    staleFields,
    "Repair wrote fields other than the stale field.",
  );
};

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
      "zeroy_inspect,zeroy_theme_checkout,zeroy_theme_push,zeroy_content_apply",
      "--extension",
      extension,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--session-dir",
      sessionDirectory,
      "--name",
      "zeroY headless translation acceptance",
      prompt,
    ],
    {
      cwd: temporary,
      env: { ...process.env, ZEROY_SITES: process.env.ZEROY_SITES },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("zeroY real-model headless acceptance timed out after 10 minutes."));
    }, 600_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exit, 0, output);
  const sessions = await sessionFiles(sessionDirectory);
  assert.equal(sessions.length, 1, "Pi did not write exactly one isolated session.");
  const events = (await readFile(sessions[0], "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assertLedger(events, output);
  process.stdout.write(`zeroY translation headless acceptance passed: ${token}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
