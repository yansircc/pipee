import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "dist/pi/extension.js");
const sites = process.env.ZEROY_SITES;
const siteId = process.env.ZEROY_ACCEPTANCE_SITE_ID;
const model = process.env.ZEROY_ACCEPTANCE_MODEL;
assert(sites, "ZEROY_SITES is required.");
assert(siteId, "ZEROY_ACCEPTANCE_SITE_ID is required.");
assert(model, "ZEROY_ACCEPTANCE_MODEL is required.");

const configuredSites = JSON.parse(sites);
const configuredSite = configuredSites.find((site) => site.siteId === siteId);
assert(configuredSite, `ZEROY_ACCEPTANCE_SITE_ID ${siteId} is not present in ZEROY_SITES.`);

const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const route = `zeroy-headless-${token}`;
const cssPath = `${route}.css`;
const cssContent = `/* zeroY headless acceptance ${token} */\n.zeroy-headless-${token} { display: block; }\n`;
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-headless-acceptance-"));
const sessionDirectory = resolve(temporary, "sessions");
let accepted = false;

const prompt = `Work only through the three available zeroY tools against site ${siteId}.

1. List configured zeroY sites, then inspect the selected site's handshake, ThemeSchema, canonical inventory, ACF structure, active-theme files and Connector integrity.
2. Create the new active-theme file ${cssPath} with exactly this content, then read that exact file back through the Connector and verify it:
${cssContent}
3. Create a new page canonical object using the showcase schema. Give it the meaningful WordPress admin title "zeroY headless acceptance ${token}". Create and publish both zh-CN and en locale content at route ${route}, using the fields required by the ThemeSchema. Re-read both locale records after publishing.

Complete the whole task. Do not use any filesystem or source-code access even if it becomes available. Report the two published URLs at the end.`;

const output = [];
try {
  const child = spawn(
    pi,
    [
      "--model",
      model,
      "--mode",
      "json",
      "--print",
      "--no-builtin-tools",
      "--tools",
      "zeroy_inspect,zeroy_theme_apply,zeroy_content_apply",
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
      "zeroY headless acceptance",
      prompt,
    ],
    {
      cwd: temporary,
      env: { ...process.env, ZEROY_SITES: sites },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    output.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.push(chunk);
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("zeroY real-model headless acceptance timed out after 10 minutes."));
    }, 600_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exitCode, 0, Buffer.concat(output).toString("utf8"));

  const findSession = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await findSession(path);
        if (found) return found;
      } else if (entry.name.endsWith(".jsonl")) {
        return path;
      }
    }
    return undefined;
  };
  const sessionPath = await findSession(sessionDirectory);
  assert(sessionPath, "Pi did not persist the acceptance session JSONL.");
  const entries = (await readFile(sessionPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const agentFailure = messages.find(
    (message) => message.role === "assistant" && message.stopReason === "error",
  );
  assert.equal(
    agentFailure,
    undefined,
    agentFailure?.errorMessage ?? "The model ended with an unknown error.",
  );
  const calls = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((content) => content.type === "toolCall")
      : [],
  );
  const results = new Map(
    messages
      .filter((message) => message.role === "toolResult")
      .map((message) => [message.toolCallId, message]),
  );
  const resultText = (call) =>
    results
      .get(call.id)
      ?.content.filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n") ?? "";
  const resultJson = (call) => JSON.parse(resultText(call));

  assert(calls.length > 0, "The model made no zeroY tool calls.");
  const allowedTools = new Set(["zeroy_inspect", "zeroy_theme_apply", "zeroy_content_apply"]);
  assert(
    calls.every((call) => allowedTools.has(call.name)),
    "A non-zeroY side-channel tool was used.",
  );
  assert(
    calls.every(
      (call) =>
        call.arguments &&
        typeof call.arguments === "object" &&
        Object.keys(call.arguments).length > 0,
    ),
    "An empty-argument probe was used.",
  );
  assert(
    messages
      .filter((message) => message.role === "toolResult")
      .every(
        (message) =>
          message.isError !== true &&
          !message.content.some(
            (content) => content.type === "text" && content.text.includes("Validation failed"),
          ),
      ),
    "A tool validation or execution failure occurred.",
  );
  for (const call of calls) {
    assert.doesNotThrow(
      () => resultJson(call),
      `zeroY tool ${call.name} returned a non-JSON error: ${resultText(call)}`,
    );
  }

  const inspectResources = new Set([
    "sites",
    "site",
    "schema",
    "inventory",
    "acf",
    "adoptionCandidates",
    "existingPost",
    "themeFiles",
    "localeContent",
    "themeCopy",
    "integrity",
    "externalCheck",
  ]);
  const contentActions = new Set([
    "siteConfig",
    "createCanonical",
    "adoptCanonical",
    "assignSchema",
    "writeDraft",
    "commit",
    "publish",
    "unpublish",
    "writeThemeCopyDraft",
    "patchThemeCopyDraft",
    "commitThemeCopy",
    "publishThemeCopy",
    "unpublishThemeCopy",
    "reconcileSchema",
  ]);
  assert(
    calls
      .filter((call) => call.name === "zeroy_inspect")
      .every((call) => inspectResources.has(call.arguments.resource)),
    "An unknown inspect resource was attempted.",
  );
  assert(
    calls.some((call) => call.name === "zeroy_inspect" && call.arguments.resource === "sites"),
    "The model did not discover configured sites through the typed sites resource.",
  );
  assert(
    calls
      .filter((call) => call.name === "zeroy_content_apply")
      .every((call) => contentActions.has(call.arguments.action)),
    "An unknown content action was attempted.",
  );

  const themeWrite = calls.find(
    (call) =>
      call.name === "zeroy_theme_apply" &&
      call.arguments.files?.some((file) => file.path === cssPath),
  );
  assert(themeWrite, `The model did not create ${cssPath}.`);
  const writtenFile = themeWrite.arguments.files.find((file) => file.path === cssPath);
  assert.equal(writtenFile.expectedHash, null);
  assert.equal(writtenFile.content, cssContent);
  const themeReadBack = calls.find(
    (call) =>
      call.name === "zeroy_inspect" &&
      call.arguments.resource === "themeFiles" &&
      call.arguments.path === cssPath,
  );
  assert(themeReadBack, "The model did not re-read the created CSS through the Connector.");
  assert.equal(resultJson(themeReadBack).content, cssContent);

  const createCanonical = calls.find(
    (call) => call.name === "zeroy_content_apply" && call.arguments.action === "createCanonical",
  );
  assert(createCanonical, "The model did not create a canonical object.");
  assert.equal(createCanonical.arguments.postTitle, `zeroY headless acceptance ${token}`);
  const canonical = resultJson(createCanonical).canonical;
  assert(canonical?.objectId > 0, "createCanonical did not return an objectId.");

  const writeDrafts = calls.filter(
    (call) => call.name === "zeroy_content_apply" && call.arguments.action === "writeDraft",
  );
  const publishes = calls.filter(
    (call) => call.name === "zeroy_content_apply" && call.arguments.action === "publish",
  );
  const commits = calls.filter(
    (call) => call.name === "zeroy_content_apply" && call.arguments.action === "commit",
  );
  for (const locale of ["zh-CN", "en"]) {
    const commit = commits.find(
      (call) => call.arguments.locale === locale && call.arguments.objectId === canonical.objectId,
    );
    let published;
    let publishedAt;
    if (commit) {
      assert.equal(
        commit.arguments.expectedRevision,
        0,
        `${locale} commit did not start at revision 0.`,
      );
      assert.equal(commit.arguments.route, route);
      published = resultJson(commit).receipt;
      publishedAt = calls.indexOf(commit);
    } else {
      const writeDraft = writeDrafts.find(
        (call) =>
          call.arguments.locale === locale && call.arguments.objectId === canonical.objectId,
      );
      assert(writeDraft, `Missing ${locale} writeDraft.`);
      assert.equal(
        writeDraft.arguments.expectedRevision,
        0,
        `${locale} did not start at revision 0.`,
      );
      assert.equal(writeDraft.arguments.route, route);
      const localeRevision = resultJson(writeDraft).receipt?.revision;
      assert.equal(typeof localeRevision, "number", `${locale} writeDraft returned no revision.`);
      const publish = publishes.find(
        (call) =>
          call.arguments.locale === locale && call.arguments.objectId === canonical.objectId,
      );
      assert(publish, `Missing ${locale} publish.`);
      assert.equal(
        publish.arguments.expectedRevision,
        localeRevision,
        `${locale} publish did not chain the writeDraft revision.`,
      );
      published = resultJson(publish).receipt;
      publishedAt = calls.indexOf(publish);
    }
    assert.equal(published?.state, "published");
    assert.equal(published?.route, route);
    const response = await fetch(published.url, { redirect: "follow" });
    assert.equal(response.status, 200, `${published.url} returned ${response.status}.`);

    const localeReadBack = calls.find(
      (call, index) =>
        index > publishedAt &&
        call.name === "zeroy_inspect" &&
        call.arguments.resource === "localeContent" &&
        call.arguments.objectId === canonical.objectId &&
        call.arguments.locale === locale,
    );
    assert(
      localeReadBack,
      `The model did not re-read published ${locale} content through the Connector.`,
    );
    const reReadLocale = resultJson(localeReadBack).localeContent;
    assert.equal(reReadLocale?.state, "published");
    assert.equal(reReadLocale?.route, route);
  }

  accepted = true;
  process.stdout.write("zeroY headless acceptance passed.\n");
} finally {
  if (accepted) {
    await rm(temporary, { recursive: true, force: true });
  } else {
    process.stderr.write(`zeroY headless acceptance failed; session retained: ${temporary}\n`);
  }
}
