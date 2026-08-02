import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readdir, readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readToolLedger } from "./headless-acceptance/ledger.mjs";
import { packageUnderTest } from "./package-under-test.mjs";

const port = process.env.ZEROY_REMOTE_ONLY_LOCALWP_PORT;
assert(
  port && /^\d+$/u.test(port),
  "ZEROY_REMOTE_ONLY_LOCALWP_PORT must identify a fresh disposable LocalWP site.",
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = `/Users/yansir/.locwp/sites/${port}/wordpress/wp-content/plugins`;
const connector = resolve(pluginRoot, "zeroy-runtime-connector");
const fixtureRoot = resolve(root, "test-suite/fixtures/site-theme");
const pi = resolve(root, "node_modules/.bin/pi");
const packaged = packageUnderTest(root);
const extension = resolve(packaged.packageRoot, "dist/pi/extension.js");

const shell = (args) =>
  execFileSync("locwp", ["wp", port, "--", ...args], { encoding: "utf8" }).trim();
const option = (name) => shell(["option", "get", name]);
const fixtureFiles = async (directory, base = directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return fixtureFiles(path, base);
        if (!entry.isFile()) return [];
        return [
          {
            path: path.slice(base.length + 1),
            content: await readFile(path, "utf8"),
            expectedHash: null,
          },
        ];
      }),
    )
  ).flat();
};
const payloadFromRequest = (request) => {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of [...messages].reverse()) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of [...content].reverse()) {
      if (item?.type !== "tool_result") continue;
      const parts = Array.isArray(item.content)
        ? item.content
        : typeof item.content === "string"
          ? [{ type: "text", text: item.content }]
          : [];
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      try {
        return JSON.parse(text);
      } catch {
        continue;
      }
    }
  }
  return null;
};
const nestedDraftId = (value) => {
  if (typeof value !== "object" || value === null) return null;
  if (typeof value.draftId === "string") return value.draftId;
  for (const child of Object.values(value)) {
    const found = nestedDraftId(child);
    if (found !== null) return found;
  }
  return null;
};
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
const receiptNextRevision = (value) => {
  if (typeof value !== "object" || value === null) return null;
  const last = value.lastOperation;
  if (typeof last === "object" && last !== null && Number.isInteger(last.nextRevision))
    return last.nextRevision;
  for (const child of Object.values(value)) {
    const found = receiptNextRevision(child);
    if (found !== null) return found;
  }
  return null;
};
const receiptFileHash = (value, path) => {
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value.lastArtifactFiles)) {
    const file = value.lastArtifactFiles.find((entry) => entry?.path === path);
    if (typeof file?.hash === "string") return file.hash;
  }
  for (const child of Object.values(value)) {
    const found = receiptFileHash(child, path);
    if (found !== null) return found;
  }
  return null;
};
const connectorErrorCode = (value) =>
  typeof value?.error?.code === "string" ? value.error.code : null;
const connectorErrorData = (value) =>
  typeof value?.error?.data === "object" && value.error.data !== null ? value.error.data : null;
const anthropicToolUse = (id, name, input) =>
  [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", content: [], model: "remote-only-gate", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
const anthropicText = () =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_done","type":"message","role":"assistant","content":[],"model":"remote-only-gate","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Remote SiteDraft committed and checked."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

await rm(connector, { recursive: true, force: true });
await mkdir(connector, { recursive: true });
execFileSync("rsync", ["-a", "--delete", `${packaged.packageRoot}/wordpress-plugin/`, connector], {
  stdio: "inherit",
});
shell(["plugin", "activate", "zeroy-runtime-connector"]);
const state = JSON.parse(
  shell([
    "eval",
    "global $wpdb; echo wp_json_encode(['active' => zeroy_runtime_active_site_release() !== null, 'releases' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_releases')), 'proofs' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('verification_proofs')), 'drafts' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_drafts')), 'canonicals' => (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . $wpdb->postmeta . ' WHERE meta_key = %s', ZEROY_RUNTIME_SCHEMA_META))]);",
  ]),
);
assert.deepEqual(
  state,
  { active: false, releases: 0, proofs: 0, drafts: 0, canonicals: 0 },
  "Remote-only acceptance requires no prior zeroY release, Draft, proof, or canonical fact.",
);

const siteId = option("zeroy_runtime_site_id");
const connectionKey = option("zeroy_runtime_connection_key");
const themeFiles = await fixtureFiles(fixtureRoot);
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-remote-only-"));
const configDirectory = resolve(temporary, "config");
const sessionDirectory = resolve(temporary, "sessions");
await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory)]);

let step = 0;
let issued = null;
let initialDraftId = null;
let initialReleaseId = null;
let blockedDraftId = null;
let blockedProofId = null;
let blockedFileHash = null;
let repairedReleaseId = null;
let staleDraftId = null;
let replacementDraftId = null;
let replacementReleaseId = null;
let replayedDraftId = null;
let replayedReleaseId = null;
let replayedProofId = null;
let translationDraftRevision = null;
const calls = [
  { tool: "zeroy_inspect", input: () => ({ resource: "sites" }) },
  { tool: "zeroy_inspect", input: () => ({ siteId, resource: "site" }) },
  { tool: "zeroy_inspect", input: () => ({ siteId, resource: "acf" }) },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "themeFiles" }),
  },
  {
    tool: "zeroy_theme_stage",
    input: () => ({ siteId, files: themeFiles }),
    receive: (result) => {
      initialDraftId = nestedDraftId(result);
    },
  },
  {
    tool: "zeroy_content_stage",
    input: () => ({
      siteId,
      draftId: initialDraftId,
      operation: {
        kind: "createCanonical",
        ref: "remote-only-home",
        postType: "page",
        schemaId: "home",
        route: "/",
        postTitle: "远程验收首页",
        postContent: "仅通过 Connector 工具创建。",
        templateContent: {
          hero_title: "远程验收首页",
          hero_subtitle: "由远程 SiteDraft 验证。",
          cta_title: "开始咨询",
        },
      },
    }),
  },
  {
    tool: "zeroy_content_stage",
    input: () => ({
      siteId,
      draftId: initialDraftId,
      operation: {
        kind: "writeTranslationDraft",
        subject: { kind: "post", ref: "remote-only-home" },
        locale: "en",
        expectedRevision: 0,
        values: {
          "/post/title": "Remote acceptance home",
          "/template-content/hero_title": "Remote acceptance home",
          "/template-content/hero_subtitle": "Verified through the remote SiteDraft.",
          "/template-content/cta_title": "Start a conversation",
        },
      },
    }),
    receive: (result) => {
      translationDraftRevision = receiptNextRevision(result);
    },
  },
  {
    tool: "zeroy_content_stage",
    input: () => ({
      siteId,
      draftId: initialDraftId,
      operation: {
        kind: "publishTranslation",
        subject: { kind: "post", ref: "remote-only-home" },
        locale: "en",
        expectedRevision: translationDraftRevision,
      },
    }),
  },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "draft", draftId: initialDraftId }),
  },
  {
    tool: "zeroy_site_commit",
    input: () => ({
      siteId,
      draftId: initialDraftId,
      expectedBaseReleaseId: null,
      message: "remote-only acceptance",
    }),
    receive: (result) => {
      initialReleaseId = nestedString(result, "releaseId");
    },
  },
  {
    tool: "zeroy_theme_stage",
    input: () => ({
      siteId,
      files: [
        {
          path: "__zeroy-proof-block.php",
          content: "<?php\nfile_put_contents(__DIR__ . '/forbidden.txt', 'blocked');\n",
          expectedHash: null,
        },
      ],
    }),
    receive: (result) => {
      blockedDraftId = nestedDraftId(result);
      blockedFileHash = receiptFileHash(result, "__zeroy-proof-block.php");
    },
  },
  {
    tool: "zeroy_site_commit",
    expectedErrorCode: "zeroy_site_commit_proof_failed",
    input: () => ({
      siteId,
      draftId: blockedDraftId,
      expectedBaseReleaseId: initialReleaseId,
      message: "prove blocked CandidateProof recovery",
    }),
    receive: (result) => {
      blockedProofId = nestedString(result, "proofId");
    },
  },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "proof", proofId: blockedProofId }),
  },
  {
    tool: "zeroy_theme_stage",
    input: () => ({
      siteId,
      draftId: blockedDraftId,
      files: [
        {
          path: "__zeroy-proof-block.php",
          content: null,
          expectedHash: blockedFileHash,
        },
      ],
    }),
  },
  {
    tool: "zeroy_site_commit",
    input: () => ({
      siteId,
      draftId: blockedDraftId,
      expectedBaseReleaseId: initialReleaseId,
      message: "activate repaired CandidateProof",
    }),
    receive: (result) => {
      repairedReleaseId = nestedString(result, "releaseId");
    },
  },
  {
    tool: "zeroy_theme_stage",
    input: () => ({
      siteId,
      files: [
        {
          path: "__zeroy-replay-stale.css",
          content: "/* staged on a soon-stale draft */\n",
          expectedHash: null,
        },
      ],
    }),
    receive: (result) => {
      staleDraftId = nestedDraftId(result);
    },
  },
  {
    tool: "zeroy_theme_stage",
    input: () => ({
      siteId,
      files: [
        {
          path: "__zeroy-replay-replacement.css",
          content: "/* replaces the active base before replay */\n",
          expectedHash: null,
        },
      ],
    }),
    receive: (result) => {
      replacementDraftId = nestedDraftId(result);
    },
  },
  {
    tool: "zeroy_site_commit",
    input: () => ({
      siteId,
      draftId: replacementDraftId,
      expectedBaseReleaseId: repairedReleaseId,
      message: "advance the active release before replay",
    }),
    receive: (result) => {
      replacementReleaseId = nestedString(result, "releaseId");
    },
  },
  {
    tool: "zeroy_site_commit",
    expectedErrorCode: "zeroy_site_draft_base_changed",
    input: () => ({
      siteId,
      draftId: staleDraftId,
      expectedBaseReleaseId: repairedReleaseId,
      message: "observe stale Draft before replay",
    }),
  },
  {
    tool: "zeroy_content_stage",
    input: () => ({
      siteId,
      operation: { kind: "replayDraft", sourceDraftId: staleDraftId },
    }),
    receive: (result) => {
      replayedDraftId = nestedDraftId(result);
    },
  },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "draft", draftId: staleDraftId }),
  },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "draft", draftId: replayedDraftId }),
  },
  {
    tool: "zeroy_site_commit",
    input: () => ({
      siteId,
      draftId: replayedDraftId,
      expectedBaseReleaseId: replacementReleaseId,
      message: "activate replayed SiteDraft",
    }),
    receive: (result) => {
      replayedReleaseId = nestedString(result, "releaseId");
      replayedProofId = nestedString(result, "proofId");
    },
  },
  {
    tool: "zeroy_inspect",
    input: () => ({ siteId, resource: "proof", proofId: replayedProofId }),
  },
  { tool: "zeroy_inspect", input: () => ({ siteId, resource: "externalCheck" }) },
];

const sockets = new Set();
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = payloadFromRequest(body);
    if (issued !== null) calls[issued].receive?.(result);
    assert(step <= calls.length, "Fake provider received more turns than planned.");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (step === calls.length) {
      response.end(anthropicText());
      return;
    }
    const call = calls[step];
    const name = call.tool;
    const input = call.input();
    const id = `call_${step + 1}`;
    issued = step;
    step += 1;
    response.end(anthropicToolUse(id, name, input));
  });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await writeFile(
    resolve(configDirectory, "models.json"),
    JSON.stringify({
      providers: {
        "zeroy-remote-only": {
          api: "anthropic-messages",
          apiKey: "remote-only-gate-key",
          baseUrl: `http://127.0.0.1:${address.port}`,
          models: [
            {
              id: "remote-only-gate",
              name: "zeroY remote-only gate",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 512,
            },
          ],
        },
      },
    }),
  );
  const output = [];
  const child = spawn(
    pi,
    [
      "--provider",
      "zeroy-remote-only",
      "--model",
      "remote-only-gate",
      "--mode",
      "json",
      "--print",
      "--no-builtin-tools",
      "--tools",
      "zeroy_inspect,zeroy_theme_stage,zeroy_content_stage,zeroy_site_commit",
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
      "zeroY remote-only deterministic acceptance",
      "Build a bilingual remote WordPress site only with zeroY tools. Do not use local files, shell, source code, database, SSH, or any other tool.",
    ],
    {
      cwd: temporary,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDirectory,
        PI_OFFLINE: "1",
        ZEROY_SITES: JSON.stringify([
          {
            siteId,
            label: "Remote-only acceptance site",
            endpoint: `http://localhost:${port}`,
            connectionKey,
          },
        ]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exit = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Remote-only Pi acceptance timed out."));
    }, 120_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(
    exit,
    0,
    "zeroY remote-only Pi process failed; raw model output is intentionally withheld.",
  );
  assert.equal(step, calls.length, "Pi did not complete the planned remote-only tool loop.");
  const sessions = await readdir(sessionDirectory, { recursive: true });
  const session = sessions.find((entry) => entry.endsWith(".jsonl"));
  assert(typeof session === "string", "Pi did not persist an isolated session.");
  const events = (await readFile(resolve(sessionDirectory, session), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const entries = readToolLedger(events);
  assert.equal(entries.length, calls.length, "Unexpected Agent tool call count.");
  const allowed = new Set([
    "zeroy_inspect",
    "zeroy_theme_stage",
    "zeroy_content_stage",
    "zeroy_site_commit",
  ]);
  for (const [index, entry] of entries.entries()) {
    assert(allowed.has(entry.name), `Remote-only session exposed ${entry.name}.`);
    assert(
      Object.keys(entry.input).length > 0,
      `Remote-only session made an empty ${entry.name} call.`,
    );
    assert(entry.result && !entry.result.isError, `Remote-only ${entry.name} host failed.`);
    const expectedErrorCode = calls[index].expectedErrorCode ?? null;
    if (expectedErrorCode === null) {
      assert(
        !entry.result.payload?.error,
        `Remote-only ${entry.name} failed: ${entry.result.text}`,
      );
    } else {
      assert.equal(
        connectorErrorCode(entry.result.payload),
        expectedErrorCode,
        `Remote-only ${entry.name} did not expose its expected Connector error.`,
      );
    }
  }
  const translationDraft = entries.find(
    (entry) =>
      entry.name === "zeroy_content_stage" &&
      entry.input.operation?.kind === "writeTranslationDraft",
  );
  const translationPublish = entries.find(
    (entry) =>
      entry.name === "zeroy_content_stage" && entry.input.operation?.kind === "publishTranslation",
  );
  assert.equal(
    translationDraft?.input.operation?.expectedRevision,
    0,
    "The first new locale stage did not use its documented revision 0.",
  );
  assert.equal(
    translationPublish?.input.operation?.expectedRevision,
    receiptNextRevision(translationDraft?.result?.payload),
    "publishTranslation did not use the preceding stage receipt's nextRevision.",
  );
  const commits = entries.filter((entry) => entry.name === "zeroy_site_commit");
  assert.equal(
    commits.at(-1)?.result?.payload?.state,
    "active",
    "Remote-only commit did not activate a SiteRelease.",
  );
  const blockedCommit = commits.find(
    (entry) => connectorErrorCode(entry.result?.payload) === "zeroy_site_commit_proof_failed",
  );
  const blockedData = connectorErrorData(blockedCommit?.result?.payload);
  const blockedFailures = nestedArray(blockedData, "blockingFailures");
  assert(
    blockedCommit &&
      blockedData?.draftId === blockedDraftId &&
      blockedData?.proofId === blockedProofId &&
      blockedFailures?.some((failure) => failure?.code === "theme_runtime_side_effect_forbidden"),
    "Blocked CandidateProof did not cross REST, client, and Pi with actionable diagnostics.",
  );
  const blockedProof = entries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "proof" &&
      entry.input.proofId === blockedProofId,
  );
  assert(
    nestedArray(blockedProof?.result?.payload, "blockingFailures")?.some(
      (failure) => failure?.code === "theme_runtime_side_effect_forbidden",
    ),
    "The Agent-visible proof inspection lost the blocked invariant and repair evidence.",
  );
  assert(
    commits.some(
      (entry) =>
        entry.input.draftId === blockedDraftId &&
        entry.result?.payload?.releaseId === repairedReleaseId &&
        entry.result?.payload?.state === "active",
    ),
    "The same blocked SiteDraft was not repaired and activated.",
  );
  const staleCommit = commits.find(
    (entry) => connectorErrorCode(entry.result?.payload) === "zeroy_site_draft_base_changed",
  );
  const staleData = connectorErrorData(staleCommit?.result?.payload);
  assert(
    staleCommit &&
      staleCommit.input.draftId === staleDraftId &&
      staleData?.baseReleaseId === repairedReleaseId &&
      staleData?.activeReleaseId === replacementReleaseId,
    "Stale SiteDraft commit did not expose both base and active release identities.",
  );
  const replay = entries.find(
    (entry) =>
      entry.name === "zeroy_content_stage" && entry.input.operation?.kind === "replayDraft",
  );
  assert(
    replay &&
      !("draftId" in replay.input) &&
      replay.result?.payload?.state === "open" &&
      replay.result.payload.replayedFromDraftId === staleDraftId,
    "Remote-only replay did not replace exactly one stale Draft through zeroy_content_stage.",
  );
  const inspectedStale = entries.find(
    (entry) => entry.name === "zeroy_inspect" && entry.input.draftId === staleDraftId,
  );
  const inspectedReplay = entries.find(
    (entry) => entry.name === "zeroy_inspect" && entry.input.draftId === replayedDraftId,
  );
  // resource:draft is a candidate-inspection document. The receipt remains
  // nested so candidate discovery and the durable Draft fact cannot diverge
  // into separate top-level response shapes.
  assert.equal(inspectedStale?.result?.payload?.draft?.state, "replayed");
  assert.equal(inspectedReplay?.result?.payload?.draft?.state, "open");
  assert(
    commits.some(
      (entry) =>
        entry.input.draftId === replayedDraftId &&
        entry.result?.payload?.releaseId === replayedReleaseId &&
        entry.result?.payload?.proofId === replayedProofId &&
        entry.result?.payload?.state === "active",
    ),
    "The replayed SiteDraft was not committed against the replacement release.",
  );
  const replayedProof = entries.find(
    (entry) =>
      entry.name === "zeroy_inspect" &&
      entry.input.resource === "proof" &&
      entry.input.proofId === replayedProofId,
  );
  assert.deepEqual(
    nestedArray(replayedProof?.result?.payload, "blockingFailures"),
    [],
    "The active replayed release did not expose a green CandidateProof.",
  );
  const external = entries.find(
    (entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck",
  )?.result?.payload?.externalCheck;
  assert(
    external &&
      external.pages.every((page) => page.status === page.expectedStatus && page.error === null),
    "Remote-only Connector check did not prove the active routes.",
  );
  process.stdout.write("zeroY deterministic remote-only Pi acceptance passed.\n");
} finally {
  // The fake provider is this acceptance process's owned resource. Pi's
  // Anthropic client is allowed to keep an HTTP socket alive after its final
  // response, so close every owned socket before awaiting server shutdown.
  // Otherwise a successful remote-only run can leave the test process alive.
  for (const socket of sockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
  packaged.cleanup();
}
