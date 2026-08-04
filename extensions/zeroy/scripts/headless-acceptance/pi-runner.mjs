import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readToolLedger } from "./ledger.mjs";

const sessionFiles = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sessionFiles(path)));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
};

const readEvents = async (path) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export const safeToolLedgerSummary = (entries) =>
  entries.map((entry) => {
    const input = entry.input;
    const scope =
      typeof input.resource === "string"
        ? `resource:${input.resource}`
        : typeof input.checkoutId === "string"
          ? "checkout"
          : "local";
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

export const assistantVisibleText = (events) =>
  events
    .flatMap((event) => {
      const message = event?.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text);
    })
    .join("\n");

export const runHeadlessPi = async ({
  pi,
  extension,
  model,
  cwd,
  sessions,
  prompt,
  env,
  name,
  session,
  timeoutMs = 600_000,
}) => {
  const args = [
    "--model",
    model,
    "--mode",
    "json",
    "--print",
    "--extension",
    extension,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--session-dir",
    sessions,
    ...(session === undefined ? ["--name", name] : ["--session", session]),
    prompt,
  ];
  const child = spawn(pi, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  let timedOut = false;
  const exit = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  const files = await sessionFiles(sessions);
  const sessionFile = session ?? (files.length === 1 ? files[0] : undefined);
  const events = sessionFile === undefined ? [] : await readEvents(sessionFile);
  const entries = readToolLedger(events);
  const summary = JSON.stringify(safeToolLedgerSummary(entries));
  assert.equal(timedOut, false, `Pi acceptance timed out; safe tool ledger: ${summary}`);
  assert.equal(exit, 0, `Pi acceptance failed; safe tool ledger: ${summary}`);
  assert(typeof sessionFile === "string", "Pi did not persist exactly one isolated session.");
  return { sessionFile, events, entries, visibleText: assistantVisibleText(events) };
};
