import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ConnectorOffline } from "../../src/core/errors.js";
import piChrome from "../../src/pi/extension.js";
import {
  AUTHORIZATION_ENTRY_TYPE,
  type SessionAuthorizationEntry,
} from "../../src/pi/authorization-owner.js";
import { CHROME_DEFAULT_TOOL_NAMES } from "../../src/pi/tools.js";
import { ATOMIC_TOOL_PROFILES } from "../../src/protocol/operation-contract.js";
import { NodeBridge } from "../../src/pi/node-bridge.js";

const customEntry = (id: string, data: SessionAuthorizationEntry): SessionEntry => ({
  type: "custom",
  customType: AUTHORIZATION_ENTRY_TYPE,
  data,
  id,
  parentId: null,
  timestamp: new Date(0).toISOString(),
});

it("reprojects tools from the current branch on every session_tree event", async () => {
  const lockedBranch = [
    customEntry("locked", {
      version: 1,
      generation: "00000000-0000-4000-8000-000000000001",
      authorization: { state: "locked" },
      background: false,
    }),
  ];
  const authorizedBranch = [
    customEntry("authorized", {
      version: 1,
      generation: "00000000-0000-4000-8000-000000000002",
      authorization: { state: "indefinite" },
      background: true,
    }),
  ];
  const allEntries = [...lockedBranch, ...authorizedBranch];
  let sessionId = "branch-session";
  let currentBranch: ReadonlyArray<SessionEntry> = lockedBranch;
  let activeTools = ["read"];
  let rejectAppend = false;
  let appendObserver: ((entry: SessionAuthorizationEntry) => void) | undefined;
  const appendedEntries: Array<SessionAuthorizationEntry> = [];
  const statuses: Array<unknown> = [];
  let chromeCommand: ((args: string, context: ExtensionContext) => Promise<unknown>) | undefined;
  const registeredTools: Array<{
    execute: (
      id: string,
      input: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ExtensionContext,
    ) => Promise<unknown>;
  }> = [];
  const handlers = new Map<
    string,
    (event: unknown, context: ExtensionContext) => Promise<unknown>
  >();
  const pi = {
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown>) =>
      handlers.set(event, handler),
    registerCommand: (
      name: string,
      command: { handler: (args: string, context: ExtensionContext) => Promise<unknown> },
    ) => {
      if (name === "chrome") chromeCommand = command.handler;
    },
    registerTool: (tool: (typeof registeredTools)[number]) => registeredTools.push(tool),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
    appendEntry: (_customType: string, data: SessionAuthorizationEntry) => {
      const entry = customEntry(`appended-${allEntries.length}`, data);
      appendedEntries.push(data);
      (currentBranch as Array<SessionEntry>).push(entry);
      allEntries.push(entry);
      appendObserver?.(data);
      if (rejectAppend) throw new Error("ledger unavailable");
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const context = {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Branch session",
      getBranch: () => [...currentBranch],
      getEntries: () => [...allEntries],
    },
    ui: {
      setStatus: (_key: string, value: unknown) => {
        statuses.push(value);
      },
      notify: () => undefined,
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  const start = vi.spyOn(NodeBridge.prototype, "start", "get").mockReturnValue(Effect.void);
  const status = vi.spyOn(NodeBridge.prototype, "status", "get").mockReturnValue(
    Effect.succeed({
      url: "http://127.0.0.1:17318",
      mode: "server",
      sessionRoutes: [],
      protocolCompatibility: {
        compatible: true,
        expectedExtensionDisplayVersion: "1.0.0",
      },
      binding: {
        connectorId: "00000000-0000-4000-8000-000000000010",
        label: "Authorization test connector",
        pairedAt: 1,
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        extensionDisplayVersion: "1.0.0",
        protocolFingerprint: "a".repeat(64),
      },
      connector: {
        connectorId: "00000000-0000-4000-8000-000000000010",
        label: "Authorization test connector",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        extensionDisplayVersion: "1.0.0",
        protocolFingerprint: "a".repeat(64),
        connected: true,
        lastSeenAt: 1,
        queuedCommands: 0,
        pendingCommands: 0,
      },
    }),
  );
  let revokeBeforeAdmission = false;
  let revokeDuringAdmission: Promise<unknown> | undefined;
  const guardedSend = vi
    .spyOn(NodeBridge.prototype, "sendTerminalGuarded")
    .mockImplementation((_connectorId, admission) =>
      Effect.suspend(() => {
        if (!revokeBeforeAdmission) return admission.pipe(Effect.andThen(Effect.succeed([])));
        revokeBeforeAdmission = false;
        revokeDuringAdmission = chromeCommand!("revoke", context);
        return Effect.promise(() => revokeDuringAdmission!).pipe(
          Effect.andThen(admission),
          Effect.andThen(Effect.succeed([])),
        );
      }),
    );
  piChrome(pi);
  const sessionTree = handlers.get("session_tree");
  expect(sessionTree).toBeDefined();

  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read"]);

  currentBranch = authorizedBranch;
  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);
  await handlers.get("before_agent_start")!({ systemPrompt: "" }, context);
  await registeredTools
    .at(-1)!
    .execute("enable", { profile: "network" }, undefined, undefined, context);
  expect(activeTools).toEqual([
    "read",
    ...CHROME_DEFAULT_TOOL_NAMES,
    ...ATOMIC_TOOL_PROFILES.network,
  ]);

  await chromeCommand!("authorize 1m", context);
  const timed = appendedEntries.at(-1)?.authorization;
  expect(timed?.state).toBe("timed");
  if (timed?.state === "timed") expect(Number.isInteger(timed.deadline)).toBe(true);
  const appendedBeforeInvalidDurations = appendedEntries.length;
  await expect(chromeCommand!("authorize 1.5", context)).rejects.toThrow("whole number");
  await expect(chromeCommand!("authorize 0x10", context)).rejects.toThrow("whole number");
  expect(appendedEntries).toHaveLength(appendedBeforeInvalidDurations);

  rejectAppend = true;
  await expect(chromeCommand!("background on", context)).rejects.toThrow("ledger unavailable");
  expect(activeTools).toEqual(["read"]);
  await expect(
    registeredTools[0]!.execute("call", { op: "list" }, undefined, undefined, context),
  ).rejects.toThrow("fail-closed after a partial append");
  rejectAppend = false;

  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read"]);
  await expect(chromeCommand!("authorize", context)).rejects.toThrow("run /chrome revoke");

  sessionId = "other-session";
  currentBranch = authorizedBranch;
  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read", ...CHROME_DEFAULT_TOOL_NAMES]);
  await handlers.get("before_agent_start")!({ systemPrompt: "" }, context);
  revokeBeforeAdmission = true;
  await expect(
    registeredTools[0]!.execute("call", {}, undefined, undefined, context),
  ).rejects.toThrow("Chrome authorization or run connector changed before tool admission");
  await revokeDuringAdmission;
  expect(activeTools).toEqual(["read"]);
  await chromeCommand!("authorize", context);

  const foreignContext = {
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getSessionId: () => "foreign-session",
    },
  } as ExtensionContext;
  await expect(
    registeredTools[0]!.execute("call", { op: "list" }, undefined, undefined, foreignContext),
  ).rejects.toThrow("is not the active Chrome authorization owner");
  const staleSameKeyContext = {
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getSessionId: () => "other-session",
      getSessionName: () => "Branch session",
    },
  } as ExtensionContext;
  await expect(
    registeredTools[0]!.execute("call", { op: "list" }, undefined, undefined, staleSameKeyContext),
  ).rejects.toThrow("is not the active Chrome authorization owner");

  sessionId = "branch-session";
  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read"]);

  await chromeCommand!("revoke", context);
  expect(appendedEntries.at(-1)?.authorization).toEqual({ state: "locked" });
  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read"]);

  const unpairOrder: string[] = [];
  appendObserver = (entry) => {
    if (entry.authorization.state === "locked") unpairOrder.push("lock");
  };
  const unpair = vi.spyOn(NodeBridge.prototype, "unpair").mockImplementation(() =>
    Effect.sync(() => {
      unpairOrder.push("unpair");
    }),
  );

  await chromeCommand!("authorize", context);
  await chromeCommand!("unpair", context);
  expect(unpairOrder).toEqual(["lock", "unpair"]);

  await chromeCommand!("authorize", context);
  unpairOrder.length = 0;
  rejectAppend = true;
  await expect(chromeCommand!("unpair", context)).rejects.toThrow("ledger unavailable");
  expect(unpairOrder).toEqual(["lock"]);
  rejectAppend = false;

  await chromeCommand!("revoke", context);
  await chromeCommand!("authorize", context);
  unpairOrder.length = 0;
  unpair.mockImplementation(() => {
    unpairOrder.push("unpair-failed");
    return Effect.fail(
      new ConnectorOffline({ connectorId: "lost", message: "connector is offline" }),
    );
  });
  await expect(chromeCommand!("unpair", context)).rejects.toThrow("connector is offline");
  expect(unpairOrder).toEqual(["lock", "unpair-failed"]);
  expect(appendedEntries.at(-1)?.authorization).toEqual({ state: "locked" });
  expect(activeTools).toEqual(["read"]);
  expect(statuses.at(-1)).toBe("● Chrome locked");
  unpair.mockRestore();

  currentBranch = lockedBranch;
  await sessionTree!({}, context);
  expect(activeTools).toEqual(["read"]);
  guardedSend.mockRestore();
  status.mockRestore();
  start.mockRestore();
});
