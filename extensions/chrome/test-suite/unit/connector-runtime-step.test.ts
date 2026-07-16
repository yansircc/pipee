import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { classifyResultDelivery } from "../../src/browser/command-journal.js";
import type { LoadedCommandJournalEntry } from "../../src/browser/command-journal.js";
import {
  connectorRuntimeStep,
  settleBrowserCommand,
  type BrowserCommandDispatch,
  type ConnectorRuntimePort,
} from "../../src/browser/connector-runtime-step.js";
import type { ProfileConnector, WireCommand } from "../../src/protocol/schema.js";
import { browserExecutionTimeoutMs } from "../../src/protocol/timeout.js";

const connector = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  secret: "a".repeat(64),
  label: "Personal Chrome",
  extensionId: "extension-package",
  extensionDisplayVersion: "0.16.0",
  protocolFingerprint: "b".repeat(64),
} satisfies ProfileConnector;

const command = (id: string): WireCommand => ({
  id,
  domain: "system",
  call: { op: "version" },
  session: { key: "session:single-flight", groupTitle: "Single flight", foreground: false },
});

it.effect("turns a browser success outside its operation contract into outcome-unknown", () =>
  Effect.gen(function* () {
    const result = yield* settleBrowserCommand(command("invalid-success"), async () => ({
      extensionDisplayVersion: "missing-extension-id-and-user-agent",
    }));

    expect(result).toMatchObject({
      id: "invalid-success",
      ok: false,
      error: { _tag: "CommandOutcomeUnknown" },
    });
  }),
);

it.effect("turns a formatted tab without an id into outcome-unknown", () =>
  Effect.gen(function* () {
    const tabCommand = {
      id: "tab-without-id",
      domain: "tab",
      call: { op: "list" },
      session: { key: "session:tab-id", groupTitle: "Tab id", foreground: false },
    } satisfies WireCommand;
    const result = yield* settleBrowserCommand(tabCommand, async () => [
      {
        windowId: 3,
        active: true,
        highlighted: true,
        title: "Missing id",
        url: "https://example.test/missing-id",
        groupId: -1,
        group: null,
      },
    ]);

    expect(result).toMatchObject({
      id: tabCommand.id,
      ok: false,
      error: { _tag: "CommandOutcomeUnknown" },
    });
  }),
);

it.effect("turns non-JSON opaque browser values into outcome-unknown", () =>
  Effect.gen(function* () {
    const evaluate = {
      id: "opaque-json",
      domain: "page",
      call: { operation: { kind: "evaluate", expression: "globalThis.value" } },
      session: { key: "session:opaque", groupTitle: "Opaque JSON", foreground: false },
    } satisfies WireCommand;
    const circular: { self?: unknown } = {};
    circular.self = circular;

    for (const value of [undefined, 1n, circular]) {
      expect(yield* settleBrowserCommand(evaluate, () => Promise.resolve(value))).toMatchObject({
        id: evaluate.id,
        ok: false,
        error: { _tag: "CommandOutcomeUnknown" },
      });
    }
  }),
);

it.effect("does not poll a second command while the first Chrome promise is still live", () => {
  const first = command("first-command");
  const second = command("second-command");
  let resolveFirst!: (value: unknown) => void;
  const firstCompletion = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });
  const commands = [first, second];
  const polled: Array<string> = [];
  const delivered: Array<string> = [];
  let executing: string | undefined;
  let journal: LoadedCommandJournalEntry | undefined;

  const dispatch: BrowserCommandDispatch = (current) =>
    current.id === first.id
      ? firstCompletion
      : Promise.resolve({
          extensionId: connector.extensionId,
          extensionDisplayVersion: connector.extensionDisplayVersion,
          userAgent: "runtime-step-test",
        });

  const port: ConnectorRuntimePort = {
    loadConnector: Effect.succeed(connector),
    loadJournal: Effect.sync(() => journal),
    deliverResult: (result) =>
      Effect.sync(() => {
        expect(classifyResultDelivery(404)).toBe("terminal");
        delivered.push(result.id);
      }),
    clearJournal: Effect.sync(() => {
      journal = undefined;
    }),
    receiveCommand: () =>
      Effect.sync(() => {
        const next = commands.shift();
        if (next) polled.push(next.id);
        return next;
      }),
    recordExecuting: (current) =>
      Effect.sync(() => {
        executing = current.id;
      }),
    executeCommand: (current) => settleBrowserCommand(current, dispatch),
    recordResult: (_command, result) =>
      Effect.sync(() => {
        executing = undefined;
        journal = { state: "result", result };
      }),
  };

  return Effect.gen(function* () {
    const threeSequentialSteps = Effect.gen(function* () {
      yield* connectorRuntimeStep(port);
      yield* connectorRuntimeStep(port);
      yield* connectorRuntimeStep(port);
    });
    const fiber = yield* Effect.forkChild(threeSequentialSteps);
    yield* Effect.yieldNow;

    expect(polled).toEqual([first.id]);
    expect(executing).toBe(first.id);
    yield* TestClock.adjust(`${browserExecutionTimeoutMs(first) + 1_000} millis`);
    yield* Effect.yieldNow;

    expect(polled).toEqual([first.id]);
    expect(delivered).toEqual([]);
    expect(executing).toBe(first.id);

    resolveFirst({
      extensionId: connector.extensionId,
      extensionDisplayVersion: connector.extensionDisplayVersion,
      userAgent: "runtime-step-test",
    });
    yield* Fiber.join(fiber);

    expect(delivered).toEqual([first.id]);
    expect(polled).toEqual([first.id, second.id]);
    expect(journal?.result.id).toBe(second.id);
  });
});

it.effect("finishes and journals an admitted Chrome command before runtime interruption", () => {
  const admitted = command("admitted-before-route-refresh");
  let resolveExecution!: (value: unknown) => void;
  const execution = new Promise<unknown>((resolve) => {
    resolveExecution = resolve;
  });
  let executing = false;
  let journaled = false;

  const port: ConnectorRuntimePort = {
    loadConnector: Effect.succeed(connector),
    loadJournal: Effect.sync(() => undefined),
    deliverResult: () => Effect.sync(() => undefined),
    clearJournal: Effect.sync(() => undefined),
    receiveCommand: () => Effect.succeed(admitted),
    recordExecuting: () =>
      Effect.sync(() => {
        executing = true;
      }),
    executeCommand: (current) => settleBrowserCommand(current, () => execution),
    recordResult: () =>
      Effect.sync(() => {
        journaled = true;
      }),
  };

  return Effect.gen(function* () {
    const commandFiber = yield* Effect.forkChild(connectorRuntimeStep(port));
    yield* Effect.yieldNow;
    expect(executing).toBe(true);

    const interruption = yield* Effect.forkChild(Fiber.interrupt(commandFiber));
    yield* Effect.yieldNow;
    expect(journaled).toBe(false);
    expect(interruption.pollUnsafe()).toBeUndefined();

    resolveExecution({
      extensionId: connector.extensionId,
      extensionDisplayVersion: connector.extensionDisplayVersion,
      userAgent: "runtime-step-test",
    });
    yield* Fiber.join(interruption);
    expect(journaled).toBe(true);
  });
});
