import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vite-plus/test";
import { BRIDGE_ORIGIN } from "../../src/protocol/bridge-contract.js";

type BridgeRecord = {
  starts: number;
  stops: number;
  sends: number;
  unpairs: number;
  forgets: number;
  sessions: string[];
  releaseStart?: () => void;
  releaseSend?: () => void;
  releaseUnpair?: () => void;
  releaseForget?: () => void;
};

const bridgeState = vi.hoisted(() => ({
  instances: [] as Array<BridgeRecord>,
  blockNextStart: false,
  blockNextSend: false,
  blockNextUnpair: false,
  blockNextForget: false,
}));

vi.mock("../../src/pi/node-bridge.js", async () => {
  const Effect = await import("effect/Effect");
  return {
    NodeBridge: {
      make: () =>
        Effect.sync(() => {
          const record: BridgeRecord = {
            starts: 0,
            stops: 0,
            sends: 0,
            unpairs: 0,
            forgets: 0,
            sessions: [],
          };
          let started = false;
          const recordSend = (_request: unknown, session: { key: string }) =>
            Effect.suspend(() => {
              record.sends += 1;
              record.sessions.push(session.key);
              if (!bridgeState.blockNextSend) return Effect.void;
              bridgeState.blockNextSend = false;
              return Effect.callback<void>((resume) => {
                record.releaseSend = () => resume(Effect.void);
                return Effect.void;
              });
            });
          bridgeState.instances.push(record);
          return {
            start: Effect.suspend(() => {
              if (started) return Effect.void;
              record.starts += 1;
              if (!bridgeState.blockNextStart) {
                started = true;
                return Effect.void;
              }
              bridgeState.blockNextStart = false;
              return Effect.callback<void>((resume) => {
                record.releaseStart = () => {
                  started = true;
                  resume(Effect.void);
                };
                return Effect.void;
              });
            }),
            stop: Effect.sync(() => {
              record.stops += 1;
            }),
            send: recordSend,
            sendGuarded: (
              admission: import("effect/Effect").Effect<void, unknown, unknown>,
              request: unknown,
              session: { key: string },
            ) => admission.pipe(Effect.andThen(() => recordSend(request, session))),
            sendTerminalGuarded: (
              _connectorId: string,
              admission: import("effect/Effect").Effect<void, unknown, unknown>,
              request: unknown,
              session: { key: string },
            ) => admission.pipe(Effect.andThen(() => recordSend(request, session))),
            sendWebGuarded: (
              _claim: unknown,
              admission: import("effect/Effect").Effect<void, unknown, unknown>,
              request: unknown,
              session: { key: string },
            ) => admission.pipe(Effect.andThen(() => recordSend(request, session))),
            stageWebRunLease: () => Effect.die("unexpected web lease"),
            assertWebRunLease: () => Effect.die("unexpected web lease"),
            releaseWebRunLease: () => Effect.void,
            detachSessionWebRoute: () => Effect.void,
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
            beginPairing: () => Effect.die("unexpected pairing"),
            unpair: () =>
              Effect.suspend(() => {
                record.unpairs += 1;
                if (!bridgeState.blockNextUnpair) return Effect.void;
                bridgeState.blockNextUnpair = false;
                return Effect.callback<void>((resume) => {
                  record.releaseUnpair = () => resume(Effect.void);
                  return Effect.void;
                });
              }),
            forget: () =>
              Effect.suspend(() => {
                record.forgets += 1;
                if (!bridgeState.blockNextForget) return Effect.void;
                bridgeState.blockNextForget = false;
                return Effect.callback<void>((resume) => {
                  record.releaseForget = () => resume(Effect.void);
                  return Effect.void;
                });
              }),
          };
        }),
    },
  };
});

import piChrome from "../../src/pi/extension.js";
import { AUTHORIZATION_ENTRY_TYPE } from "../../src/pi/authorization-owner.js";
import { CHROME_DEFAULT_TOOL_NAMES } from "../../src/pi/tools.js";

type EventHandler = (event: unknown, context: ExtensionContext) => unknown;

const lockedEntry: SessionEntry = {
  type: "custom",
  customType: AUTHORIZATION_ENTRY_TYPE,
  data: {
    version: 1,
    generation: "00000000-0000-4000-8000-000000000001",
    authorization: { state: "locked" },
    background: false,
  },
  id: "locked",
  parentId: null,
  timestamp: new Date(0).toISOString(),
};

const authorizedEntry: SessionEntry = {
  ...lockedEntry,
  data: {
    version: 1,
    generation: "00000000-0000-4000-8000-000000000002",
    authorization: { state: "indefinite" },
    background: false,
  },
  id: "authorized",
};

const extensionFixture = (mode: ExtensionContext["mode"] = "tui") => {
  const handlers = new Map<string, EventHandler>();
  const messages: Array<unknown> = [];
  const structuredStatuses: Array<unknown> = [];
  let activeTools = ["read"];
  let chromeCommand: ((args: string, context: ExtensionContext) => Promise<unknown>) | undefined;
  let sessionId = "runtime-session";
  let branch: ReadonlyArray<SessionEntry> = [lockedEntry];
  const pi = {
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      command: { handler: (args: string, context: ExtensionContext) => Promise<unknown> },
    ) => {
      if (name === "chrome") chromeCommand = command.handler;
    },
    registerTool: () => undefined,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: Array<string>) => {
      activeTools = tools;
    },
    appendEntry: () => undefined,
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Runtime session",
      getBranch: () => branch,
      getEntries: () => [lockedEntry, authorizedEntry],
    },
    ui: {
      setStatus: () => undefined,
      ...(mode === "rpc"
        ? {
            setStructuredStatus: (_key: string, status: unknown) => {
              structuredStatuses.push(status);
            },
          }
        : {}),
      notify: () => undefined,
      confirm: () => Promise.resolve(true),
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  return {
    handlers,
    pi,
    context,
    messages,
    structuredStatuses,
    chromeCommand: () => chromeCommand!,
    activeTools: () => activeTools,
    setSession: (nextId: string, nextBranch: ReadonlyArray<SessionEntry>) => {
      sessionId = nextId;
      branch = nextBranch;
    },
  };
};

const handler = (handlers: ReadonlyMap<string, EventHandler>, event: string): EventHandler => {
  const registered = handlers.get(event);
  if (!registered) throw new Error(`Missing ${event} handler`);
  return registered;
};

it("leaves a locked RPC session out of Chrome run admission", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  const fixture = extensionFixture("rpc");
  fixture.setSession("locked-rpc-session", [lockedEntry]);
  piChrome(fixture.pi);

  await handler(fixture.handlers, "session_start")({}, fixture.context);
  expect(fixture.structuredStatuses.at(-1)).toMatchObject({
    readiness: "locked",
    authorization: "locked",
    connection: "unpaired",
  });
  expect(fixture.structuredStatuses.at(-1)).not.toHaveProperty("connectorId");
  await expect(
    handler(fixture.handlers, "before_agent_start")(
      { systemPrompt: "base prompt" },
      fixture.context,
    ) as Promise<unknown>,
  ).resolves.toBeUndefined();
  expect(fixture.activeTools()).toEqual(["read"]);

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});

it("keeps an RPC session without a persisted Web route detached from Terminal", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  const fixture = extensionFixture("rpc");
  fixture.setSession("rpc-session", [authorizedEntry]);
  piChrome(fixture.pi);

  await handler(fixture.handlers, "session_start")({}, fixture.context);
  await expect(
    handler(fixture.handlers, "before_agent_start")(
      { systemPrompt: "" },
      fixture.context,
    ) as Promise<unknown>,
  ).rejects.toThrow("No Chrome connector is attached to this Pi session");

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});

it("projects the durable Terminal connector for a non-RPC session", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  const fixture = extensionFixture("tui");
  fixture.setSession("tui-session", [authorizedEntry]);
  piChrome(fixture.pi);

  await handler(fixture.handlers, "session_start")({}, fixture.context);
  await expect(
    handler(fixture.handlers, "before_agent_start")(
      { systemPrompt: "" },
      fixture.context,
    ) as Promise<unknown>,
  ).resolves.toMatchObject({ systemPrompt: expect.stringContaining("<pi-chrome>") });

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});

it("owns one bridge per extension registration and stops it on every shutdown", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();

  piChrome(fixture.pi);
  piChrome(fixture.pi);
  expect(bridgeState.instances).toHaveLength(1);

  await handler(fixture.handlers, "session_start")({}, fixture.context);
  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
  expect(bridgeState.instances[0]).toMatchObject({ starts: 1, stops: 1, sends: 0, sessions: [] });

  piChrome(fixture.pi);
  expect(bridgeState.instances).toHaveLength(2);
  await handler(fixture.handlers, "session_start")({}, fixture.context);
  await handler(fixture.handlers, "session_shutdown")({ reason: "replacement" }, fixture.context);
  expect(bridgeState.instances[1]).toMatchObject({
    starts: 1,
    stops: 1,
    sends: 1,
    sessions: ["session:runtime-session"],
  });
});

it("serializes session projection behind bridge start and publishes only the newest epoch", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = true;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();
  piChrome(fixture.pi);

  const start = handler(fixture.handlers, "session_start")({}, fixture.context) as Promise<unknown>;
  await vi.waitFor(() => expect(bridgeState.instances[0]?.releaseStart).toBeTypeOf("function"));

  fixture.setSession("newer-session", [authorizedEntry]);
  const tree = handler(fixture.handlers, "session_tree")({}, fixture.context) as Promise<unknown>;
  await Promise.resolve();
  expect(fixture.activeTools()).toEqual(["read"]);

  bridgeState.instances[0]!.releaseStart!();
  await Promise.all([start, tree]);
  expect(fixture.activeTools()).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});

it("keeps a pending start from publishing after shutdown", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = true;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();
  fixture.setSession("closing-session", [authorizedEntry]);
  piChrome(fixture.pi);

  const start = handler(fixture.handlers, "session_start")({}, fixture.context) as Promise<unknown>;
  await vi.waitFor(() => expect(bridgeState.instances[0]?.releaseStart).toBeTypeOf("function"));
  const shutdown = handler(fixture.handlers, "session_shutdown")(
    { reason: "replacement" },
    fixture.context,
  ) as Promise<unknown>;
  expect(fixture.activeTools()).toEqual(["read"]);

  bridgeState.instances[0]!.releaseStart!();
  await Promise.all([start, shutdown]);
  expect(fixture.activeTools()).toEqual(["read"]);
  expect(bridgeState.instances[0]).toMatchObject({ starts: 1, stops: 1, sends: 0 });
});

it("cleans the captured active session instead of rereading a mutated context", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();
  fixture.setSession("owned-session", [lockedEntry]);
  piChrome(fixture.pi);
  await handler(fixture.handlers, "session_start")({}, fixture.context);

  fixture.setSession("unrelated-session", [authorizedEntry]);
  await handler(fixture.handlers, "session_shutdown")({ reason: "replacement" }, fixture.context);

  expect(bridgeState.instances[0]?.sessions).toEqual(["session:owned-session"]);
});

it("finishes revoked-session cleanup before a reauthorization can publish", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();
  fixture.setSession("serialized-authorization", [authorizedEntry]);
  piChrome(fixture.pi);
  await handler(fixture.handlers, "session_start")({}, fixture.context);

  bridgeState.blockNextSend = true;
  const revoke = fixture.chromeCommand()("revoke", fixture.context);
  await vi.waitFor(() => expect(bridgeState.instances[0]?.releaseSend).toBeTypeOf("function"));
  const authorize = fixture.chromeCommand()("authorize", fixture.context);
  await Promise.resolve();
  expect(fixture.activeTools()).toEqual(["read"]);

  bridgeState.instances[0]!.releaseSend!();
  await Promise.all([revoke, authorize]);
  expect(fixture.activeTools()).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});

it.each(["unpair", "forget"] as const)(
  "keeps %s and its durable lock in one authorization transition",
  async (command) => {
    bridgeState.instances.length = 0;
    bridgeState.blockNextStart = false;
    bridgeState.blockNextSend = false;
    bridgeState.blockNextUnpair = command === "unpair";
    bridgeState.blockNextForget = command === "forget";
    const fixture = extensionFixture();
    fixture.setSession(`serialized-${command}`, [authorizedEntry]);
    piChrome(fixture.pi);
    await handler(fixture.handlers, "session_start")({}, fixture.context);

    const destructive = fixture.chromeCommand()(command, fixture.context);
    const releaseKey = command === "unpair" ? "releaseUnpair" : "releaseForget";
    await vi.waitFor(() => expect(bridgeState.instances[0]?.[releaseKey]).toBeTypeOf("function"));
    const authorize = fixture.chromeCommand()("authorize", fixture.context);
    await Promise.resolve();
    expect(fixture.activeTools()).toEqual(["read"]);

    bridgeState.instances[0]![releaseKey]!();
    await Promise.all([destructive, authorize]);
    expect(fixture.activeTools()).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);

    await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
  },
);

it("does not publish an old revoke result into a superseding session", async () => {
  bridgeState.instances.length = 0;
  bridgeState.blockNextStart = false;
  bridgeState.blockNextSend = false;
  const fixture = extensionFixture();
  fixture.setSession("revoked-session", [authorizedEntry]);
  piChrome(fixture.pi);
  await handler(fixture.handlers, "session_start")({}, fixture.context);

  bridgeState.blockNextSend = true;
  const revoke = fixture.chromeCommand()("revoke", fixture.context);
  await vi.waitFor(() => expect(bridgeState.instances[0]?.releaseSend).toBeTypeOf("function"));

  fixture.setSession("replacement-session", [authorizedEntry]);
  const replacement = handler(fixture.handlers, "session_tree")(
    {},
    fixture.context,
  ) as Promise<unknown>;
  bridgeState.instances[0]!.releaseSend!();

  await expect(revoke).rejects.toThrow("changed while the Chrome operation was running");
  await replacement;
  expect(fixture.messages).toEqual([]);
  expect(fixture.activeTools()).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);

  await handler(fixture.handlers, "session_shutdown")({ reason: "reload" }, fixture.context);
});
