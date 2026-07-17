import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vite-plus/test";
import { BRIDGE_ORIGIN } from "../../src/protocol/bridge-contract.js";

type BridgeRecord = {
  starts: number;
  stops: number;
  sends: Array<string>;
};

const bridgeState = vi.hoisted(() => ({ instances: [] as Array<BridgeRecord> }));

vi.mock("../../src/pi/node-bridge.js", async () => {
  const Effect = await import("effect/Effect");
  return {
    NodeBridge: {
      make: () =>
        Effect.sync(() => {
          const record: BridgeRecord = { starts: 0, stops: 0, sends: [] };
          bridgeState.instances.push(record);
          const send = (_request: unknown, session: { key: string }) =>
            Effect.sync(() => {
              record.sends.push(session.key);
              return {};
            });
          return {
            start: Effect.sync(() => {
              record.starts += 1;
            }),
            stop: Effect.sync(() => {
              record.stops += 1;
            }),
            send,
            sendGuarded: (
              admission: import("effect/Effect").Effect<void, unknown, unknown>,
              request: unknown,
              session: { key: string },
            ) => admission.pipe(Effect.andThen(() => send(request, session))),
            status: Effect.succeed({
              url: BRIDGE_ORIGIN,
              mode: "server",
              sessionRoutes: [],
              extensionExpectation: {
                extensionId: "abcdefghijklmnopabcdefghijklmnop",
                displayVersion: "1.0.0",
                protocolFingerprint: "a".repeat(64),
              },
              binding: {
                connectorId: "00000000-0000-4000-8000-000000000001",
                label: "Runtime connector",
                pairedAt: 1,
                extensionId: "abcdefghijklmnopabcdefghijklmnop",
                extensionDisplayVersion: "1.0.0",
                protocolFingerprint: "a".repeat(64),
              },
              connector: {
                connectorId: "00000000-0000-4000-8000-000000000001",
                label: "Runtime connector",
                extensionId: "abcdefghijklmnopabcdefghijklmnop",
                extensionDisplayVersion: "1.0.0",
                protocolFingerprint: "a".repeat(64),
                connected: true,
                lastSeenAt: 1,
                queuedCommands: 0,
                pendingCommands: 0,
              },
            }),
          };
        }),
    },
  };
});

import piChrome from "../../src/pi/extension.js";
import { CHROME_DEFAULT_TOOL_NAMES, CHROME_TOOL_NAMES } from "../../src/pi/tools.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

const fixture = () => {
  const handlers = new Map<string, EventHandler>();
  const tools = new Map<string, ToolDefinition>();
  const statuses: Array<unknown> = [];
  let commands = 0;
  let activeTools = ["read"];
  let sessionId = "runtime-session";
  const pi = {
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {
      commands += 1;
    },
    getActiveTools: () => activeTools,
    setActiveTools: (names: Array<string>) => {
      activeTools = names;
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "rpc",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Runtime session",
      getBranch: () => [],
    },
    ui: {
      setStatus: () => undefined,
      setStructuredStatus: (_key: string, status: unknown) => statuses.push(status),
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    context,
    handlers,
    tools,
    statuses,
    commandCount: () => commands,
    activeTools: () => activeTools,
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
};

const handler = (handlers: ReadonlyMap<string, EventHandler>, event: string): EventHandler => {
  const registered = handlers.get(event);
  if (!registered) throw new Error(`Missing ${event} handler`);
  return registered;
};

it("exposes Agent Chrome tools immediately and publishes read-only readiness", async () => {
  bridgeState.instances.length = 0;
  const test = fixture();
  piChrome(test.pi);

  expect([...test.tools.keys()]).toEqual(CHROME_TOOL_NAMES);
  expect(test.activeTools()).toEqual(["read"]);
  expect(test.commandCount()).toBe(0);

  await handler(test.handlers, "session_start")({}, test.context);
  expect(test.activeTools()).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);
  expect(test.statuses.at(-1)).toMatchObject({ version: 3, state: "ready" });

  const start = await handler(test.handlers, "before_agent_start")(
    { systemPrompt: "base" },
    test.context,
  );
  expect(start).toMatchObject({
    systemPrompt: expect.stringContaining("operate the single compatible local Chrome connector"),
  });

  const status = test.tools.get("chrome_status")!;
  const result = await status.execute("status", {}, undefined, undefined, test.context);
  expect(result).toMatchObject({ details: { status: { state: "ready" } } });
});

it("cleans the previous session target on identity change and shutdown", async () => {
  bridgeState.instances.length = 0;
  const test = fixture();
  piChrome(test.pi);
  await handler(test.handlers, "session_start")({}, test.context);

  test.setSessionId("next-session");
  await handler(test.handlers, "session_tree")({}, test.context);
  await handler(test.handlers, "session_shutdown")({ reason: "exit" }, test.context);

  expect(bridgeState.instances[0]).toMatchObject({
    starts: 2,
    stops: 1,
    sends: ["session:runtime-session", "session:next-session"],
  });
});
