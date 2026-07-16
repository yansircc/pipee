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

const commands = new Map();
const handlers = new Map();
const notifications = [];
const statuses = new Map();
const pi = {
  registerCommand: (name, command) => commands.set(name, command),
  registerTool: () => undefined,
  on: (name, handler) => handlers.set(name, handler),
};
const context = {
  cwd: temporary,
  hasUI: true,
  mode: "rpc",
  ui: {
    notify: (message) => notifications.push(message),
    setStatus: (key, value) => statuses.set(key, value),
    setStructuredStatus: (key, value) => statuses.set(key, value),
    setWidget: () => undefined,
  },
  sessionManager: {
    getSessionId: () => "release-domain-check",
    getSessionFile: () => resolve(temporary, "session.jsonl"),
  },
};

try {
  extension(pi);
  const command = commands.get("weixin");
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(command && start && shutdown, "archive bridge/lifecycle surface is incomplete");

  await start({}, context);
  await command.handler("status", context);
  assert.match(notifications.at(-1), /已停止，未登录，未绑定 session/);

  await command.handler("start", context);
  assert.match(notifications.at(-1), /等待启动，未登录，未绑定 session/);
  assert.equal(
    notifications.some((message) => message.includes("运行中")),
    false,
    "unconfigured archive bridge must not report a live connection",
  );

  await command.handler("stop", context);
  assert.match(notifications.at(-1), /已停止，未登录，未绑定 session/);
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
