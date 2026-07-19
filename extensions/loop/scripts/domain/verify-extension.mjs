import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRootInput = process.env.PI_EXTENSION_PACKAGE_ROOT ?? process.argv[2];
assert.ok(packageRootInput, "pi:domain-check requires the raw package root");
const packageRoot = resolve(packageRootInput);
const extensionPath = resolve(packageRoot, "dist", "pi", "extension.js");
const extension = (await import(pathToFileURL(extensionPath).href)).default;
assert.equal(typeof extension, "function", "archive extension must export a registration function");

const cwd = mkdtempSync(resolve(tmpdir(), "pi-loop-domain-"));
const handlers = new Map();
const tools = new Map();
const entries = [];
let surfaceProjection;
let surfaceRegistration;
const pi = {
  on: (name, handler) => handlers.set(name, handler),
  registerCommand: () => undefined,
  registerTool: (tool) => tools.set(tool.name, tool),
  sendUserMessage: () => undefined,
  appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
};
const context = {
  cwd,
  hasUI: true,
  ui: {
    notify: () => undefined,
    setStatus: () => undefined,
    getPiSuiteCapability: (_ownerId, id) =>
      id === "pi-suite/runtime-retention@1"
        ? { acquire: () => ({ release: () => undefined }) }
        : id === "pi-suite/web-surface-runtime@1"
          ? {
              register: (registration) => {
                surfaceRegistration = registration;
                return {
                  replace: (value) => {
                    surfaceProjection = value;
                  },
                  release: () => undefined,
                };
              },
            }
          : undefined,
  },
  sessionManager: {
    getSessionId: () => "release-domain-check",
    getEntries: () => entries,
  },
};
const textOf = (result) => result.content.map((item) => item.text ?? "").join("\n");

try {
  extension(pi);
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  const create = tools.get("loop_create");
  const list = tools.get("loop_list");
  const remove = tools.get("loop_delete");
  assert.ok(
    start && shutdown && create && list && remove,
    "archive lifecycle/Agent-first tool surface is incomplete",
  );

  await start({}, context);
  assert.equal(surfaceProjection.kind, "pi-loop/web-surface");
  assert.equal(typeof surfaceRegistration.dispatch, "function");
  const created = textOf(
    await create.execute("release-create", {
      prompt: "release domain probe",
      schedule: { kind: "interval", periodSeconds: 300, runImmediately: false },
      retention: "session",
    }),
  );
  assert.match(created, /^Created \[/, "loop_create did not create an archive-backed loop");
  const id = created.match(/^Created \[([^\]]+)\]/)?.[1];
  assert.ok(id, "loop_create result did not expose the loop id");

  const listed = textOf(await list.execute("release-list", {}));
  assert.match(listed, /release domain probe/, "loop_list did not observe the created loop");
  const paused = await surfaceRegistration.dispatch(
    { requestId: "release-pause", payload: { _tag: "SetEnabled", id, enabled: false } },
    new AbortController().signal,
  );
  assert.equal(paused._tag, "Accepted", "Web Surface action did not reach Loop operations");
  assert.equal(
    surfaceProjection.loops.find((loop) => loop.id === id)?.enabled,
    false,
    "Web Surface action did not update the Runtime projection",
  );
  const deleted = textOf(await remove.execute("release-delete", { target: { kind: "one", id } }));
  assert.equal(deleted, "Deleted 1 loop.");
  assert.equal(textOf(await list.execute("release-list-empty", {})), "No active loops");
  await shutdown({}, context);

  process.stdout.write(`${JSON.stringify({ loopLifecycle: true, id })}\n`);
} finally {
  try {
    await handlers.get("session_shutdown")?.({}, context);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
