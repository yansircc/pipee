import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CommandBroker } from "../../src/core/broker.js";
import {
  classifyResultDelivery,
  loadCommandJournal,
  recordCommandExecuting,
  recordCommandResult,
} from "../../src/browser/command-journal.js";
import manifest from "../../src/browser/manifest.json" with { type: "json" };
import { protocolFingerprint } from "../../src/protocol/protocol-fingerprint.js";
import { REQUEST_BODY_BYTE_LIMIT } from "../../src/protocol/bridge-contract.js";
import type { WireCommand, WireResult } from "../../src/protocol/schema.js";

const storage: Record<string, unknown> = {};

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (value: Record<string, unknown>) => Object.assign(storage, value),
        remove: async (key: string) => {
          delete storage[key];
        },
      },
    },
  },
});

const command = {
  id: "journal-command",
  domain: "system",
  call: { op: "version" },
  session: { key: "session:journal", groupTitle: "Pi Journal", foreground: false },
} satisfies WireCommand;

const reset = Effect.sync(() => {
  for (const key of Object.keys(storage)) delete storage[key];
});

it.effect("recovers an interrupted execution as outcome-unknown without re-executing", () =>
  Effect.gen(function* () {
    yield* reset;
    yield* recordCommandExecuting(command);

    const recovered = yield* loadCommandJournal;
    expect(recovered).toMatchObject({
      state: "result",
      result: {
        id: command.id,
        ok: false,
        error: { _tag: "CommandOutcomeUnknown" },
      },
    });
    expect(yield* loadCommandJournal).toEqual(recovered);
  }),
);

it.effect("completes an interrupted broker command as outcome unknown after journal recovery", () =>
  Effect.gen(function* () {
    yield* reset;
    const broker = yield* CommandBroker.make;
    const connector = {
      connectorId: "journal-connector",
      label: "Journal Chrome",
      extensionId: "extension-package",
      extensionDisplayVersion: "1.0.0",
      protocolFingerprint: "a".repeat(64),
    } as const;
    yield* broker.register(connector.connectorId);
    const receiver = yield* Effect.forkChild(broker.next(connector, 1_000));
    yield* Effect.yieldNow;
    const sender = yield* Effect.forkChild(
      broker.send(
        connector.connectorId,
        { domain: "system", call: { op: "version" } },
        command.session,
        1_000,
      ),
    );
    const executing = yield* Fiber.join(receiver);
    expect(executing).toBeDefined();
    yield* recordCommandExecuting(executing!);

    const recovered = yield* loadCommandJournal;
    expect(recovered?.state).toBe("result");
    if (recovered?.state !== "result") return;
    expect(yield* broker.complete(connector, recovered.result)).toBe(true);

    const failure = yield* Fiber.join(sender).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "CommandOutcomeUnknown" });
    yield* broker.stop;
  }),
);

it.effect("keeps an executed result durable until the runtime receives an acknowledgement", () =>
  Effect.gen(function* () {
    yield* reset;
    const result = {
      id: command.id,
      ok: true,
      value: {
        extensionId: "extension-package",
        extensionDisplayVersion: "1.0.0",
        userAgent: "journal-test",
      },
    } satisfies WireResult;
    yield* recordCommandResult(command, result);

    expect(yield* loadCommandJournal).toEqual({ state: "result", result });
  }),
);

it.effect("keeps executing state when a result belongs to another command", () =>
  Effect.gen(function* () {
    yield* reset;
    yield* recordCommandExecuting(command);

    const write = yield* Effect.exit(
      recordCommandResult(command, {
        id: "different-command",
        ok: false,
        error: { _tag: "CommandRejected", code: "test", message: "wrong command" },
      }),
    );
    expect(write._tag).toBe("Failure");
    expect(yield* loadCommandJournal).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
  }),
);

it.effect("durably projects an invalid success to outcome-unknown", () =>
  Effect.gen(function* () {
    yield* reset;
    yield* recordCommandExecuting(command);

    const write = yield* Effect.exit(
      recordCommandResult(command, {
        id: command.id,
        ok: true,
        value: { extensionId: "missing-version-and-user-agent" },
      }),
    );
    expect(write._tag).toBe("Success");
    expect(yield* loadCommandJournal).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
  }),
);

it.effect("persists a bounded outcome-unknown instead of an oversized result", () =>
  Effect.gen(function* () {
    yield* reset;
    const marker = "oversized-journal-payload";
    yield* recordCommandResult(command, {
      id: command.id,
      ok: true,
      value: {
        extensionId: "extension-package",
        extensionDisplayVersion: "1.0.0",
        userAgent: `${marker}${"x".repeat(REQUEST_BODY_BYTE_LIMIT)}`,
      },
    });

    expect(yield* loadCommandJournal).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
    const persisted = JSON.stringify(storage.piChromeCommandJournal);
    expect(persisted).not.toContain(marker);
    expect(new TextEncoder().encode(persisted).byteLength).toBeLessThan(REQUEST_BODY_BYTE_LIMIT);
  }),
);

it.effect("clears an unrecoverable journal only when it has no stable command id", () =>
  Effect.gen(function* () {
    yield* reset;
    storage.piChromeCommandJournal = { state: "executing", command: { id: "incomplete" } };

    expect(yield* loadCommandJournal).toBeUndefined();
    expect(storage.piChromeCommandJournal).toBeUndefined();
  }),
);

it.effect("projects a mismatched protocol journal to one durable outcome-unknown", () =>
  Effect.gen(function* () {
    yield* reset;
    yield* recordCommandExecuting(command);
    storage.piChromeCommandJournal = {
      ...(storage.piChromeCommandJournal as Record<string, unknown>),
      protocolFingerprint: "f".repeat(64),
    };

    const recovered = yield* loadCommandJournal;
    expect(recovered).toMatchObject({
      state: "result",
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
    expect(yield* loadCommandJournal).toEqual(recovered);
    expect(storage.piChromeCommandJournal).toMatchObject({
      version: 1,
      protocolFingerprint: yield* protocolFingerprint,
      commandId: command.id,
      state: "result",
      payload: { kind: "recovered" },
    });
  }),
);

it.effect("projects a current but wrongly associated success to outcome-unknown", () =>
  Effect.gen(function* () {
    yield* reset;
    storage.piChromeCommandJournal = {
      version: 1,
      protocolFingerprint: yield* protocolFingerprint,
      commandId: command.id,
      state: "result",
      payload: {
        kind: "current",
        command,
        result: { id: command.id, ok: true, value: { extensionId: "missing-fields" } },
      },
    };

    expect(yield* loadCommandJournal).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
  }),
);

it.effect("recovers an unknown journal version when its stable command id remains readable", () =>
  Effect.gen(function* () {
    yield* reset;
    storage.piChromeCommandJournal = {
      version: 99,
      protocolFingerprint: "not-current",
      commandId: command.id,
      state: "future-state",
      payload: { incompatible: true },
    };

    expect(yield* loadCommandJournal).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
  }),
);

it.effect("normalizes a forged recovered result to one durable outcome-unknown", () =>
  Effect.gen(function* () {
    yield* reset;
    storage.piChromeCommandJournal = {
      version: 1,
      protocolFingerprint: yield* protocolFingerprint,
      commandId: command.id,
      state: "result",
      payload: {
        kind: "recovered",
        result: {
          id: command.id,
          ok: false,
          error: { _tag: "CommandRejected", code: "forged", message: "not a recovery" },
        },
      },
    };

    const recovered = yield* loadCommandJournal;
    expect(recovered).toMatchObject({
      result: { id: command.id, ok: false, error: { _tag: "CommandOutcomeUnknown" } },
    });
    expect(yield* loadCommandJournal).toEqual(recovered);
  }),
);

it("clears results only after acknowledgement or explicit command termination", () => {
  expect(classifyResultDelivery(200)).toBe("terminal");
  expect(classifyResultDelivery(204)).toBe("blocked");
  expect(classifyResultDelivery(404)).toBe("terminal");
  expect(classifyResultDelivery(401)).toBe("blocked");
  expect(classifyResultDelivery(403)).toBe("blocked");
  expect(classifyResultDelivery(503)).toBe("retry");
  expect(classifyResultDelivery(400)).toBe("blocked");
});

it("keeps the durable result journal outside the storage.local quota", () => {
  expect(manifest.permissions).toContain("unlimitedStorage");
});

it("declares only the Chrome APIs owned by the browser runtime", () => {
  expect(manifest.permissions).toEqual([
    "tabs",
    "tabGroups",
    "scripting",
    "storage",
    "unlimitedStorage",
    "alarms",
    "debugger",
  ]);
  expect(manifest.externally_connectable).toEqual({
    matches: ["http://localhost/*", "http://127.0.0.1/*"],
  });
});
