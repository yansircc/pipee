import { expect, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Data, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  capabilitySlotKey,
  makeExtensionHostCapabilities,
} from "@pipee/host-runtime/extension-capabilities";
import { setTimeout as delay } from "node:timers/promises";
import piLoop from "../src/pi/extension.js";

class InvocationFailure extends Data.TaggedError("InvocationFailure")<{
  readonly name: string;
  readonly cause: unknown;
}> {}

class WaitFailure extends Data.TaggedError("WaitFailure")<{
  readonly cause: unknown;
}> {}

const wait = (milliseconds: number) =>
  Effect.tryPromise({
    try: () => delay(milliseconds),
    catch: (cause) => new WaitFailure({ cause }),
  });

type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

const invoke = (name: string, call: () => unknown) =>
  Effect.suspend(() => {
    const result = call();
    return result instanceof Promise
      ? Effect.tryPromise({
          try: () => result,
          catch: (cause) => new InvocationFailure({ name, cause }),
        }).pipe(Effect.asVoid)
      : Effect.void;
  });

it.effect("gates the real Pi callback path until the agent becomes idle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-loop-extension-" });
      yield* fs.writeFileString(
        `${cwd}/.pi-loop.config.json`,
        JSON.stringify({ checkIntervalMs: 10, recurringJitterFraction: 0 }),
      );

      const handlers = new Map<string, Handler>();
      const tools = new Map<string, ToolDefinition>();
      const messages: Array<string> = [];
      const entries: Array<unknown> = [];
      const statuses = new Map<string, unknown>();
      const capabilities = makeExtensionHostCapabilities({
        webSurfaceCandidates: new Map([["@yansircc/pi-loop", "a".repeat(64) as never]]),
        replaceStructuredView: (ownerId, slot, value) => {
          const key = capabilitySlotKey(ownerId, slot);
          if (value === undefined) statuses.delete(key);
          else statuses.set(key, value);
        },
        replaceMediaView: () => undefined,
      });
      const pi = {
        on: (name: string, handler: Handler) => handlers.set(name, handler),
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        sendUserMessage: (message: string) => messages.push(message),
        appendEntry: (customType: string, data: unknown) =>
          entries.push({ type: "custom", customType, data }),
      } as unknown as ExtensionAPI;
      piLoop(pi);

      const context = {
        cwd,
        hasUI: true,
        ui: {
          notify: () => undefined,
          setStatus: () => undefined,
          getPipeeCapability: (ownerId: string, id: string) =>
            capabilities.providers.get(id)?.forExtension(ownerId),
        },
        sessionManager: {
          getSessionId: () => "session-automation",
          getEntries: () => entries,
        },
      } as unknown as ExtensionContext;
      const start = handlers.get("session_start");
      const busy = handlers.get("agent_start");
      const idle = handlers.get("agent_end");
      const shutdown = handlers.get("session_shutdown");
      const create = tools.get("loop_create");
      const runNow = tools.get("loop_run_now");
      expect(start).toBeDefined();
      expect(busy).toBeDefined();
      expect(idle).toBeDefined();
      expect(shutdown).toBeDefined();
      expect(create).toBeDefined();
      expect(runNow).toBeDefined();
      expect([...tools.keys()].sort((left, right) => left.localeCompare(right))).toEqual([
        "loop_create",
        "loop_delete",
        "loop_list",
        "loop_pause",
        "loop_resume",
        "loop_run_now",
        "loop_update",
        "schedule_wakeup",
      ]);

      yield* invoke("session_start", () => start?.({}, context));
      yield* invoke("agent_start", () => busy?.({}, context));
      yield* wait(20);
      yield* invoke("loop", () =>
        create?.execute(
          "create-1",
          {
            prompt: "inspect build",
            schedule: { kind: "interval", periodSeconds: 420, runImmediately: true },
            retention: "session",
          },
          undefined,
          undefined,
          context,
        ),
      );
      yield* wait(30);
      expect(messages).toEqual([]);

      yield* invoke("agent_end", () => idle?.({}, context));
      yield* wait(30);
      expect(messages).toEqual(["inspect build"]);

      yield* invoke("loop-immediate", () =>
        create?.execute(
          "create-2",
          {
            prompt: "immediate probe",
            schedule: { kind: "interval", periodSeconds: 540, runImmediately: true },
            retention: "session",
          },
          undefined,
          undefined,
          context,
        ),
      );
      expect(messages).toEqual(["inspect build", "immediate probe"]);
      expect(statuses.get(capabilitySlotKey("@yansircc/pi-loop", "status"))).toMatchObject({
        kind: "pi-loop/status",
        version: 1,
        sessionId: "session-automation",
        loops: [{ prompt: "inspect build" }, { prompt: "immediate probe" }],
      });
      expect(capabilities.hasRetention()).toBe(true);

      yield* invoke("run-now", () =>
        runNow?.execute("run-missing", { id: "missing" }, undefined, undefined, context),
      ).pipe(Effect.exit);
      expect(messages).toEqual(["inspect build", "immediate probe"]);

      yield* invoke("session_shutdown", () => shutdown?.({}, context));
      expect(capabilities.hasRetention()).toBe(false);
      yield* invoke("session_restart", () => start?.({}, context));
      yield* invoke("agent_idle", () => idle?.({}, context));
      yield* wait(20);
      expect(messages).toEqual(["inspect build", "immediate probe"]);

      yield* invoke("session_shutdown", () => shutdown?.({}, context));
      expect(yield* fs.exists(`${cwd}/.pi-loop.json.lock`)).toBe(false);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);
