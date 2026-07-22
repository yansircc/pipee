import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRootInput = process.env.PI_EXTENSION_PACKAGE_ROOT ?? process.argv[2];
assert.ok(packageRootInput, "pi:domain-check requires the raw package root");
const packageRoot = resolve(packageRootInput);
const temporary = mkdtempSync(resolve(tmpdir(), "pi-weixin-domain-"));
const statePath = resolve(temporary, "state.json");
process.env.PI_WEIXIN_STATE_PATH = statePath;

const extension = (
  await import(pathToFileURL(resolve(packageRoot, "dist", "pi", "extension.js")).href)
).default;
assert.equal(typeof extension, "function", "archive extension must export a registration function");

const handlers = new Map();
const tools = new Map();
const notifications = [];
const statuses = new Map();
let livePresentation;
let surfaceProjection;
let surfaceRegistration;
const pi = {
  registerTool: (tool) => tools.set(tool.name, tool),
  on: (name, handler) => handlers.set(name, handler),
};
const context = {
  cwd: temporary,
  hasUI: true,
  mode: "rpc",
  ui: {
    notify: (message) => notifications.push(message),
    setStatus: (key, value) => statuses.set(key, value),
    setWidget: () => undefined,
    getPipeeCapability: (_ownerId, id) =>
      id === "pipee/runtime-retention@2"
        ? { acquire: () => ({ release: () => undefined }) }
        : id === "pipee/web-surface-runtime@2"
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
          : id === "pipee/live-presentation@1"
            ? {
                replace: (_slot, value) => {
                  livePresentation = value;
                },
              }
            : undefined,
  },
  sessionManager: {
    getSessionId: () => "release-domain-check",
    getSessionFile: () => resolve(temporary, "session.jsonl"),
  },
};

try {
  extension(pi);
  const status = tools.get("weixin_status");
  const disconnect = tools.get("weixin_disconnect");
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(
    status && disconnect && start && shutdown,
    "archive Agent-first/lifecycle surface is incomplete",
  );

  await start({}, context);
  assert.equal(surfaceProjection.kind, "pi-weixin/web-surface");
  assert.equal(livePresentation.contract, "pipee/presentation@1");
  assert.equal(livePresentation.title, "Weixin");
  assert.equal(typeof surfaceRegistration.dispatch, "function");
  const initial = await status.execute("release-status", {}, undefined, undefined, context);
  assert.match(initial.content[0].text, /已停止，未登录/);
  assert.equal(initial.details.phase, "Stopped");
  assert.equal(initial.details.accountId, undefined);
  assert.equal(initial.details.defaultSessionId, undefined);
  assert.equal(initial.details.pipeePresentation.contract, "pipee/presentation@1");
  assert.equal(
    notifications.some((message) => message.includes("运行中")),
    false,
    "unconfigured archive bridge must not report a live connection",
  );

  const stopped = await disconnect.execute("release-disconnect", {}, undefined, undefined, context);
  assert.match(stopped.content[0].text, /已停止，未登录/);
  assert.equal(stopped.details.phase, "Stopped");
  await shutdown({}, context);

  assert.equal(
    existsSync(statePath),
    true,
    "offline lifecycle did not persist its state projection",
  );
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.enabled, false);
  assert.equal(state.auth, undefined);
  assert.equal(state.binding, undefined);
  process.stdout.write(`${JSON.stringify({ bridgeOffline: true, notifications })}\n`);
} finally {
  try {
    await handlers.get("session_shutdown")?.({}, context);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
