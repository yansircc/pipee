import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "dist/pi/extension.js");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-pi-schema-"));
const configDirectory = resolve(temporary, "config");
const sessionDirectory = resolve(temporary, "sessions");
await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory)]);

let captured;
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_schema_gate","type":"message","role":"assistant","content":[],"model":"schema-gate","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    );
    response.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
    );
    response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
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
        "zeroy-schema-gate": {
          api: "anthropic-messages",
          apiKey: "schema-gate-key",
          baseUrl: `http://127.0.0.1:${address.port}`,
          models: [
            {
              id: "schema-gate",
              name: "zeroY schema transport gate",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 256,
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
      "zeroy-schema-gate",
      "--model",
      "schema-gate",
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
      "zeroY schema transport gate",
      "Send a short acknowledgement without calling a tool.",
    ],
    {
      cwd: temporary,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDirectory,
        PI_OFFLINE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Pi schema transport gate timed out."));
    }, 20_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exitCode, 0, Buffer.concat(output).toString("utf8"));
  assert(captured, "Pi did not send an Anthropic Messages request.");

  const tools = new Map(captured.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    [...tools.keys()],
    ["zeroy_inspect", "zeroy_theme_apply", "zeroy_content_apply"],
  );

  const inspect = tools.get("zeroy_inspect")?.input_schema;
  assert.equal(inspect?.type, "object");
  assert.deepEqual(inspect?.required, ["resource"]);
  assert.deepEqual(inspect?.properties?.resource?.enum, [
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
  assert(Object.keys(inspect?.properties ?? {}).length > 2);

  const content = tools.get("zeroy_content_apply")?.input_schema;
  assert.equal(content?.type, "object");
  assert.deepEqual(content?.required, ["siteId", "action"]);
  assert.deepEqual(content?.properties?.action?.enum, [
    "siteConfig",
    "createCanonical",
    "adoptCanonical",
    "assignSchema",
    "writeDraft",
    "publish",
    "unpublish",
    "writeThemeCopyDraft",
    "publishThemeCopy",
    "unpublishThemeCopy",
  ]);
  assert.match(
    content?.properties?.expectedRevision?.description ?? "",
    /LocaleHead always starts at 0/u,
  );
  assert.match(content?.properties?.expectedRevision?.description ?? "", /canonical revision/u);
  assert.match(content?.properties?.postTitle?.description ?? "", /WordPress administrator title/u);
  assert.match(
    content?.properties?.expectedSourceHash?.description ?? "",
    /ACF facts have not changed/u,
  );

  const theme = tools.get("zeroy_theme_apply")?.input_schema;
  assert.match(
    theme?.properties?.files?.items?.properties?.expectedHash?.description ?? "",
    /existing file; use null for a new file/u,
  );
  assert.match(inspect?.properties?.path?.description ?? "", /Omit path to list/u);

  process.stdout.write("Pi Anthropic schema transport gate passed.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
