import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { CommandBroker } from "../../src/core/broker.js";
import {
  BridgeStopped,
  CommandOutcomeUnknown,
  CommandRejected,
  CommandTimeout,
  ConnectorOffline,
  ProtocolFailure,
} from "../../src/core/errors.js";
import {
  CONNECTOR_LEASE_DEADLINE_MS,
  MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
  REQUEST_BODY_BYTE_LIMIT,
} from "../../src/protocol/bridge-contract.js";
import { OperationResultValidationFailure } from "../../src/protocol/operation-contract.js";

const session = {
  key: "session:test",
  groupTitle: "Pi Session: test",
  foreground: true,
} as const;

const primary = {
  connectorId: "connector-primary",
  label: "Default",
  extensionId: "extension-package",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
} as const;

const secondary = {
  connectorId: "connector-secondary",
  label: "Testing",
  extensionId: "extension-package",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
} as const;

const opaqueRequest = {
  domain: "page",
  call: { operation: { kind: "evaluate", expression: "globalThis.__piBrokerTest" } },
} as const;

it.effect("rejects an oversized command before reserving mailbox state", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 1));
    yield* Effect.yieldNow;

    const failure = yield* broker
      .send(
        primary.connectorId,
        {
          domain: "page",
          call: {
            operation: {
              kind: "evaluate",
              expression: "x".repeat(REQUEST_BODY_BYTE_LIMIT),
            },
          },
        },
        session,
        1_000,
      )
      .pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ProtocolFailure);
    expect(yield* broker.status(primary.connectorId)).toMatchObject({
      queuedCommands: 0,
      pendingCommands: 0,
    });

    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(heartbeat)).toBeUndefined();
    yield* broker.stop;
  }),
);

it.effect("routes a command and its result through exactly one connector mailbox", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const command = yield* Fiber.join(receiver);
    expect(command?.domain).toBe("page");
    expect(command?.session).toEqual(session);

    expect(
      yield* broker.complete(secondary, {
        id: command!.id,
        ok: true,
        value: "wrong profile",
      }),
    ).toBe(false);
    expect(
      yield* broker.complete(primary, {
        id: command!.id,
        ok: true,
        value: { arbitrary: "page-defined result" },
      }),
    ).toBe(true);
    expect(yield* Fiber.join(sender)).toEqual({ arbitrary: "page-defined result" });
    yield* broker.stop;
  }),
);

it.effect("keeps a precise command executing until a valid result completes it", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, { domain: "tab", call: { op: "list" } }, session, 1_000),
    );
    const command = yield* Fiber.join(receiver);

    expect(
      yield* broker
        .complete(primary, { id: command!.id, ok: true, value: "not-a-tab-list" })
        .pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
    expect(yield* broker.status(primary.connectorId)).toMatchObject({ pendingCommands: 1 });
    expect(yield* broker.next(primary, 1_000)).toBeUndefined();

    expect(yield* broker.complete(primary, { id: command!.id, ok: true, value: [] })).toBe(true);
    expect(yield* Fiber.join(sender)).toEqual([]);
    yield* broker.stop;
  }),
);

it.effect("restores a rejected terminal result as the domain error", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const command = yield* Fiber.join(receiver);
    expect(command).toBeDefined();
    expect(
      yield* broker.complete(primary, {
        id: command!.id,
        ok: false,
        error: {
          _tag: "CommandRejected",
          code: "browser-operation",
          message: "click failed",
        },
      }),
    ).toBe(true);

    const failure = yield* Fiber.join(sender).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(CommandRejected);
    expect(failure).toMatchObject({ code: "browser-operation", message: "click failed" });
    yield* broker.stop;
  }),
);

it.effect("admits only one executing command per connector mailbox", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);

    const firstPoll = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const overlappingPoll = yield* Effect.forkChild(broker.next(primary, 1_000));
    const firstSender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const firstCommand = yield* Fiber.join(firstPoll);
    expect(firstCommand).toBeDefined();
    expect(yield* Fiber.join(overlappingPoll)).toBeUndefined();

    const secondSender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    yield* Effect.yieldNow;
    expect(yield* broker.next(primary, 1_000)).toBeUndefined();
    expect(yield* broker.status(primary.connectorId)).toMatchObject({
      queuedCommands: 1,
      pendingCommands: 1,
    });

    expect(
      yield* broker.complete(primary, {
        id: firstCommand!.id,
        ok: true,
        value: "first",
      }),
    ).toBe(true);
    expect(yield* Fiber.join(firstSender)).toBe("first");

    const secondCommand = yield* broker.next(primary, 1_000);
    expect(secondCommand).toBeDefined();
    expect(
      yield* broker.complete(primary, {
        id: secondCommand!.id,
        ok: true,
        value: "second",
      }),
    ).toBe(true);
    expect(yield* Fiber.join(secondSender)).toBe("second");
    yield* broker.stop;
  }),
);

it.effect("never makes an unbound connector a fallback route", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    const secondaryPoll = yield* Effect.forkChild(broker.next(secondary, 100));
    yield* Effect.yieldNow;
    const outcome = yield* Effect.exit(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    expect(outcome._tag).toBe("Failure");
    yield* TestClock.adjust("100 millis");
    expect(yield* Fiber.join(secondaryPoll)).toBeUndefined();
    yield* broker.stop;
  }),
);

it.effect("never delivers a command after its caller is interrupted", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);

    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(sender);

    const receiver = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    expect(yield* Fiber.join(receiver)).toBeUndefined();
    expect((yield* broker.status(primary.connectorId)).pendingCommands).toBe(0);
    yield* broker.stop;
  }),
);

it.effect("reports outcome unknown when its caller cancels after delivery", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);

    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const command = yield* Fiber.join(receiver);
    expect(command).toBeDefined();

    yield* Fiber.interrupt(sender);
    const cancelled = yield* Fiber.await(sender);
    const error = Option.getOrThrow(Exit.findErrorOption(cancelled));
    expect(error).toBeInstanceOf(CommandOutcomeUnknown);
    expect(
      yield* broker.complete(primary, {
        id: command!.id,
        ok: true,
        value: "completed after cancellation",
      }),
    ).toBe(false);
    yield* broker.stop;
  }),
);

it.effect("fails immediately when the bound connector lease is offline", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);
    yield* TestClock.adjust(`${CONNECTOR_LEASE_DEADLINE_MS} millis`);

    const outcome = yield* Effect.exit(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    expect(outcome._tag).toBe("Failure");
    expect((yield* broker.status(primary.connectorId)).queuedCommands).toBe(0);
    yield* broker.stop;
  }),
);

it.effect("refreshes a stale connector lease on a matching long-running command result", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const firstPoll = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const firstSender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 60_000),
    );
    const firstCommand = yield* Fiber.join(firstPoll);
    expect(firstCommand).toBeDefined();

    yield* TestClock.adjust(`${CONNECTOR_LEASE_DEADLINE_MS + 1_000} millis`);
    expect(
      yield* broker.complete(primary, {
        id: firstCommand!.id,
        ok: true,
        value: "long command completed",
      }),
    ).toBe(true);
    expect(yield* Fiber.join(firstSender)).toBe("long command completed");

    const secondSender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const secondCommand = yield* broker.next(primary, 1_000);
    expect(secondCommand).toBeDefined();
    expect(
      yield* broker.complete(primary, {
        id: secondCommand!.id,
        ok: true,
        value: "accepted after result heartbeat",
      }),
    ).toBe(true);
    expect(yield* Fiber.join(secondSender)).toBe("accepted after result heartbeat");
    yield* broker.stop;
  }),
);

it.effect("does not refresh the connector lease for an unknown result", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);
    yield* TestClock.adjust(`${CONNECTOR_LEASE_DEADLINE_MS} millis`);

    expect(
      yield* broker.complete(primary, {
        id: "unknown-command",
        ok: true,
        value: "not pending",
      }),
    ).toBe(false);
    expect(
      yield* broker.send(primary.connectorId, opaqueRequest, session, 1_000).pipe(Effect.flip),
    ).toBeInstanceOf(ConnectorOffline);
    yield* broker.stop;
  }),
);

it.effect("allows only the connector claim that took a command to complete it", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const poll = yield* Effect.forkChild(broker.next(primary, 1_000));
    yield* Effect.yieldNow;
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, { domain: "tab", call: { op: "list" } }, session, 1_000),
    );
    const command = yield* Fiber.join(poll);
    expect(command).toBeDefined();

    expect(
      yield* broker.complete(
        { ...primary, protocolFingerprint: "b".repeat(64) },
        { id: command!.id, ok: true, value: "must not be validated" },
      ),
    ).toBe(false);
    expect(
      yield* broker.complete(
        { ...primary, extensionId: "different-extension-package" },
        { id: command!.id, ok: true, value: "must not be validated" },
      ),
    ).toBe(false);
    expect(yield* broker.status(primary.connectorId)).toMatchObject({ pendingCommands: 1 });
    expect(yield* broker.next(primary, 1_000)).toBeUndefined();

    expect(yield* broker.complete(primary, { id: command!.id, ok: true, value: [] })).toBe(true);
    expect(yield* Fiber.join(sender)).toEqual([]);
    yield* broker.stop;
  }),
);

it.effect("reports a retryable timeout only while the command is still queued", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);

    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");

    expect(yield* Fiber.join(sender).pipe(Effect.flip)).toBeInstanceOf(CommandTimeout);
    expect(yield* broker.status(primary.connectorId)).toMatchObject({
      queuedCommands: 0,
      pendingCommands: 0,
    });
    const receiver = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    expect(yield* Fiber.join(receiver)).toBeUndefined();
    yield* broker.stop;
  }),
);

it.effect("bounds admitted and stale queued commands without blocking overload callers", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 1));
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(heartbeat);

    const senders = yield* Effect.forEach(
      Array.from({ length: MAX_ADMITTED_COMMANDS_PER_CONNECTOR }),
      () => Effect.forkChild(broker.send(primary.connectorId, opaqueRequest, session, 1_000)),
    );
    yield* Effect.yieldNow;
    expect(yield* broker.status(primary.connectorId)).toMatchObject({
      queuedCommands: MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
      pendingCommands: 0,
    });

    const overloaded = yield* broker
      .send(primary.connectorId, opaqueRequest, session, 1_000)
      .pipe(Effect.flip);
    expect(overloaded).toMatchObject({ _tag: "CommandRejected", code: "connector-busy" });

    const interrupted = senders.slice(0, MAX_ADMITTED_COMMANDS_PER_CONNECTOR / 2);
    yield* Effect.forEach(interrupted, Fiber.interrupt, { discard: true });
    yield* TestClock.adjust("1 second");
    const exits = yield* Effect.forEach(senders, Fiber.await);
    expect(exits.every(Exit.isFailure)).toBe(true);
    expect(yield* broker.status(primary.connectorId)).toMatchObject({
      queuedCommands: 0,
      pendingCommands: 0,
    });

    const physicallyFull = yield* broker
      .send(primary.connectorId, opaqueRequest, session, 1_000)
      .pipe(Effect.flip);
    expect(physicallyFull).toMatchObject({ _tag: "CommandRejected", code: "connector-busy" });

    const drain = yield* Effect.forkChild(broker.next(primary, 1));
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(drain)).toBeUndefined();

    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    const command = yield* Fiber.join(receiver);
    expect(command).toBeDefined();
    expect(
      yield* broker.complete(primary, {
        id: command!.id,
        ok: true,
        value: "accepted after stale queue drain",
      }),
    ).toBe(true);
    expect(yield* Fiber.join(sender)).toBe("accepted after stale queue drain");
    yield* broker.stop;
  }),
);

it.effect("reports outcome unknown when the reply deadline expires after delivery", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);

    const receiver = yield* Effect.forkChild(broker.next(primary, 1_000));
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );
    expect(yield* Fiber.join(receiver)).toBeDefined();
    yield* TestClock.adjust("1 second");

    expect(yield* Fiber.join(sender).pipe(Effect.flip)).toBeInstanceOf(CommandOutcomeUnknown);
    yield* broker.stop;
  }),
);

it.effect("drop marks a delivered command outcome unknown and stops current and future polls", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    const heartbeat = yield* Effect.forkChild(broker.next(primary, 100));
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(heartbeat);

    const commandTaken = yield* Deferred.make<void>();
    const releasePoll = yield* Deferred.make<void>();
    const receiver = yield* Effect.forkChild(
      Effect.gen(function* () {
        const command = yield* broker.next(primary, 1_000);
        expect(command?.domain).toBe("page");
        yield* Deferred.succeed(commandTaken, undefined);
        yield* Deferred.await(releasePoll);
      }),
    );
    const sender = yield* Effect.forkChild(
      broker.send(primary.connectorId, opaqueRequest, session, 1_000),
    );

    yield* Deferred.await(commandTaken);
    yield* broker.drop(primary.connectorId);

    const failure = yield* Fiber.join(sender).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(CommandOutcomeUnknown);
    expect(yield* broker.next(primary, 1_000)).toBeUndefined();
    expect((yield* broker.status(primary.connectorId)).pendingCommands).toBe(0);

    yield* Deferred.succeed(releasePoll, undefined);
    yield* Fiber.join(receiver);
    yield* broker.stop;
  }),
);

it.effect("makes broker stop terminal even when a binding republishes afterward", () =>
  Effect.gen(function* () {
    const broker = yield* CommandBroker.make;
    yield* broker.register(primary.connectorId);
    yield* broker.stop;
    yield* broker.register(primary.connectorId);
    yield* broker.register(secondary.connectorId);

    expect(
      yield* broker.send(primary.connectorId, opaqueRequest, session, 1_000).pipe(Effect.flip),
    ).toBeInstanceOf(BridgeStopped);
    expect(yield* broker.next(primary, 1_000)).toBeUndefined();
    expect(yield* broker.next(secondary, 1_000)).toBeUndefined();
    expect(yield* broker.status(primary.connectorId)).toMatchObject({ connected: false });
    yield* broker.stop;
  }),
);
