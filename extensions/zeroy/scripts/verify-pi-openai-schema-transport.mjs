import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = resolve(packageRoot, "node_modules/.bin/pi");
const extension = resolve(packageRoot, "dist/pi/extension.js");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-pi-openai-schema-"));
const configDirectory = resolve(temporary, "config");
const sessionDirectory = resolve(temporary, "sessions");
await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory)]);

let captured;
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-zeroy-schema-gate",
        object: "chat.completion",
        created: 1,
        model: "schema-gate",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
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
        "zeroy-openai-schema-gate": {
          api: "openai-completions",
          apiKey: "schema-gate-key",
          baseUrl: `http://127.0.0.1:${address.port}`,
          models: [
            {
              id: "schema-gate",
              name: "zeroY OpenAI-compatible schema transport gate",
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
      "zeroy-openai-schema-gate",
      "--model",
      "schema-gate",
      "--mode",
      "json",
      "--print",
      "--no-builtin-tools",
      "--tools",
      "zeroy_inspect,zeroy_checkout,zeroy_push",
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
      "zeroY OpenAI schema transport gate",
      "Send a short acknowledgement without calling a tool.",
    ],
    {
      cwd: temporary,
      env: { ...process.env, PI_CODING_AGENT_DIR: configDirectory, PI_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Pi OpenAI-compatible schema transport gate timed out."));
    }, 20_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exitCode, 0, Buffer.concat(output).toString("utf8"));
  assert(captured, "Pi did not send an OpenAI-compatible request.");
  const tools = new Map(captured.tools.map((tool) => [tool.function.name, tool.function]));
  assert.deepEqual([...tools.keys()], ["zeroy_inspect", "zeroy_checkout", "zeroy_push"]);
  const { validateProviderSchemaDocument } = await import(pathToFileURL(extension).href);
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters?.type, "object", `${name}: top-level parameters is not object`);
    const validation = validateProviderSchemaDocument(tool.parameters);
    assert.equal(
      validation._tag,
      "Success",
      `${name}: ${validation._tag === "Failure" ? validation.error.message : "invalid schema"}`,
    );
    const encoded = JSON.stringify(tool.parameters);
    assert.doesNotMatch(encoded, /"\$ref":"(?!#\/)/u, `${name}: non-local ref leaked`);
    assert.doesNotMatch(
      encoded,
      /"additionalProperties"/u,
      `${name}: provider parameters leaked additionalProperties`,
    );
  }
  process.stdout.write("Pi OpenAI-compatible and Moonshot-safe schema transport gate passed.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
