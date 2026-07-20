import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  CONNECTOR_LEASE_DEADLINE_MS,
  MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
} from "../protocol/bridge-contract.js";
import {
  BridgeStopped,
  CommandOutcomeUnknown,
  CommandRejected,
  CommandTimeout,
  ConnectorOffline,
  ProtocolFailure,
  type BridgeFailure,
} from "./errors.js";
import { fromWireCommandTerminalFailure, makeWireCommand } from "../protocol/codec.js";
import {
  validateOperationSuccess,
  type OperationResultValidationFailure,
} from "../protocol/operation-contract.js";
import { encodeJsonTransport } from "../protocol/json-transport.js";
import type { JsonValue } from "../protocol/json-value.js";
import { WireCommand as WireCommandSchema } from "../protocol/schema.js";
import type {
  PublicConnector,
  SessionContext,
  WireCommand,
  WireDomainRequest,
  WireResult,
} from "../protocol/schema.js";

type PendingBase = {
  readonly command: WireCommand;
  readonly reply: Deferred.Deferred<unknown, BridgeFailure>;
};

type ConnectorClaim = Pick<PublicConnector, "extensionId" | "protocolFingerprint">;

type Pending =
  | (PendingBase & { readonly phase: "queued" })
  | (PendingBase & {
      readonly phase: "executing" | "completing";
      readonly claim: ConnectorClaim;
    });

type Connection = PublicConnector & {
  readonly lastSeenAt: number;
};

type ActiveMailbox = {
  readonly _tag: "Active";
  readonly pending: ReadonlyMap<string, Pending>;
  readonly connection: Connection | undefined;
};

type MailboxState = ActiveMailbox | { readonly _tag: "Stopped" };

type Mailbox = {
  readonly queue: Queue.Queue<WireCommand>;
  readonly delivery: Semaphore.Semaphore;
  readonly state: SynchronizedRef.SynchronizedRef<MailboxState>;
  readonly stopped: Deferred.Deferred<void>;
};

type BrokerState =
  | {
      readonly _tag: "Active";
      readonly mailboxes: ReadonlyMap<string, Mailbox>;
    }
  | { readonly _tag: "Stopped" };

export type BrokerStatus = {
  readonly connectorId: string;
  readonly connected: boolean;
  readonly queuedCommands: number;
  readonly pendingCommands: number;
  readonly lastSeenAt?: number;
  readonly label?: string;
  readonly extensionId?: string;
  readonly extensionDisplayVersion?: string;
  readonly protocolFingerprint?: string;
};

export class CommandBroker {
  private constructor(private readonly state: SynchronizedRef.SynchronizedRef<BrokerState>) {}

  static make = SynchronizedRef.make<BrokerState>({ _tag: "Active", mailboxes: new Map() }).pipe(
    Effect.map((state) => new CommandBroker(state)),
  );

  register(connectorId: string): Effect.Effect<void> {
    return SynchronizedRef.modifyEffect(this.state, (state) => {
      if (state._tag === "Stopped") return Effect.succeed([undefined, state] as const);
      const entries = state.mailboxes;
      if (entries.has(connectorId)) return Effect.succeed([undefined, state] as const);
      return makeMailbox.pipe(
        Effect.map(
          (mailbox) =>
            [
              undefined,
              { _tag: "Active", mailboxes: new Map(entries).set(connectorId, mailbox) },
            ] as const,
        ),
      );
    });
  }

  drop(connectorId: string): Effect.Effect<void> {
    return SynchronizedRef.modifyEffect(this.state, (state) => {
      if (state._tag === "Stopped") return Effect.succeed([undefined, state] as const);
      const entries = state.mailboxes;
      const mailbox = entries.get(connectorId);
      if (!mailbox) return Effect.succeed([undefined, state] as const);
      return stopMailbox(mailbox).pipe(
        Effect.map(() => {
          const next = new Map(entries);
          next.delete(connectorId);
          return [undefined, { _tag: "Active", mailboxes: next } as const] as const;
        }),
      );
    });
  }

  send(
    connectorId: string,
    request: WireDomainRequest,
    session: SessionContext,
    timeoutMs: number,
  ): Effect.Effect<unknown, BridgeFailure> {
    const stateRef = this.state;
    return Effect.gen(function* () {
      const brokerState = yield* SynchronizedRef.get(stateRef);
      if (brokerState._tag === "Stopped") {
        return yield* new BridgeStopped({ message: "Chrome bridge is stopped" });
      }
      const mailbox = brokerState.mailboxes.get(connectorId);
      if (!mailbox) {
        return yield* new ConnectorOffline({
          connectorId,
          message: `Bound Chrome connector ${shortId(connectorId)} is offline`,
        });
      }

      const id = globalThis.crypto.randomUUID();
      const reply = yield* Deferred.make<unknown, BridgeFailure>();
      const command = yield* encodeJsonTransport(
        "Chrome wire command",
        WireCommandSchema,
        makeWireCommand(id, request, session),
      ).pipe(
        Effect.map(({ value }) => value),
        Effect.mapError(
          (cause) =>
            new ProtocolFailure({
              message: "Chrome command cannot cross the JSON transport boundary",
              cause,
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const reservation = yield* SynchronizedRef.modify(mailbox.state, (state) => {
        if (state._tag === "Stopped") return ["stopped", state] as const;
        if (!state.connection || now - state.connection.lastSeenAt >= CONNECTOR_LEASE_DEADLINE_MS) {
          return ["offline", state] as const;
        }
        if (state.pending.size >= MAX_ADMITTED_COMMANDS_PER_CONNECTOR) {
          return ["busy", state] as const;
        }
        return [
          "reserved",
          {
            ...state,
            pending: new Map(state.pending).set(id, { command, reply, phase: "queued" }),
          },
        ] as const;
      });
      if (reservation === "stopped") {
        return yield* new BridgeStopped({ message: "Chrome connector mailbox stopped" });
      }
      if (reservation === "offline") {
        return yield* new ConnectorOffline({
          connectorId,
          message: `Bound Chrome connector ${shortId(connectorId)} is offline`,
        });
      }
      if (reservation === "busy") return yield* connectorBusy(connectorId);

      const timeout = Effect.sleep(`${timeoutMs} millis`).pipe(
        Effect.andThen(timeoutFailure(mailbox, command, timeoutMs)),
      );
      const lifecycle = Effect.gen(function* () {
        const offered = yield* Queue.offer(mailbox.queue, command);
        if (!offered) {
          return yield* rejectFailedOffer(mailbox, command.id, connectorId);
        }
        return yield* Effect.raceFirst(Deferred.await(reply), timeout);
      });
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(lifecycle).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? interruptedFailure(mailbox, command, cause)
              : Effect.failCause(cause),
          ),
          Effect.ensuring(removePending(mailbox, id)),
        ),
      );
    });
  }

  next(
    connector: PublicConnector,
    timeoutMs: number,
    onConnected: Effect.Effect<void> = Effect.void,
  ): Effect.Effect<WireCommand | undefined> {
    const stateRef = this.state;
    return Effect.gen(function* () {
      const brokerState = yield* SynchronizedRef.get(stateRef);
      if (brokerState._tag === "Stopped") return undefined;
      const mailbox = brokerState.mailboxes.get(connector.connectorId);
      if (!mailbox) return undefined;
      const lastSeenAt = yield* Clock.currentTimeMillis;
      const active = yield* SynchronizedRef.modify(mailbox.state, (state) =>
        state._tag === "Stopped"
          ? [false, state]
          : [true, { ...state, connection: { ...connector, lastSeenAt } }],
      );
      if (!active) return undefined;
      yield* onConnected;
      return yield* mailbox.delivery.withPermits(1)(
        Effect.gen(function* () {
          const deliveryState = yield* SynchronizedRef.get(mailbox.state);
          if (
            deliveryState._tag === "Stopped" ||
            [...deliveryState.pending.values()].some(({ phase }) => phase !== "queued")
          ) {
            return undefined;
          }
          const takeActive = Effect.gen(function* () {
            while (true) {
              const command = yield* Queue.take(mailbox.queue);
              const claimed = yield* SynchronizedRef.modify(mailbox.state, (state) => {
                if (state._tag === "Stopped") return [undefined, state] as const;
                const current = state.pending.get(command.id);
                if (!current) return [undefined, state] as const;
                const pending = new Map(state.pending).set(command.id, {
                  ...current,
                  phase: "executing" as const,
                  claim: {
                    extensionId: connector.extensionId,
                    protocolFingerprint: connector.protocolFingerprint,
                  },
                });
                return [command, { ...state, pending }] as const;
              });
              if (claimed) return claimed;
            }
          });
          return yield* Effect.raceAllFirst([
            takeActive,
            Deferred.await(mailbox.stopped).pipe(Effect.as(undefined)),
            Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(undefined)),
          ]);
        }),
      );
    });
  }

  complete(
    connector: PublicConnector,
    result: WireResult,
  ): Effect.Effect<boolean, OperationResultValidationFailure> {
    const stateRef = this.state;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const brokerState = yield* SynchronizedRef.get(stateRef);
        if (brokerState._tag === "Stopped") return false;
        const mailbox = brokerState.mailboxes.get(connector.connectorId);
        if (!mailbox) return false;
        const lastSeenAt = yield* Clock.currentTimeMillis;
        const completion = yield* SynchronizedRef.modifyEffect(mailbox.state, (state) => {
          if (state._tag === "Stopped") return Effect.succeed([undefined, state] as const);
          const current = state.pending.get(result.id);
          if (!current || current.phase !== "executing")
            return Effect.succeed([undefined, state] as const);
          const claimMatches =
            current.claim.extensionId === connector.extensionId &&
            current.claim.protocolFingerprint === connector.protocolFingerprint;
          if (!claimMatches) return Effect.succeed([undefined, state] as const);
          const validated: Effect.Effect<JsonValue | undefined, OperationResultValidationFailure> =
            result.ok
              ? validateOperationSuccess(current.command, result.value)
              : Effect.succeed(undefined);
          return validated.pipe(
            Effect.map((value) => {
              const pending = new Map(state.pending).set(result.id, {
                ...current,
                phase: "completing" as const,
              });
              return [
                { pending: current, value },
                {
                  ...state,
                  pending,
                  connection: { ...connector, lastSeenAt },
                },
              ] as const;
            }),
          );
        });
        if (!completion) return false;
        if (result.ok) yield* Deferred.succeed(completion.pending.reply, completion.value);
        else
          yield* Deferred.fail(
            completion.pending.reply,
            fromWireCommandTerminalFailure(result.error),
          );
        yield* removePending(mailbox, result.id);
        return true;
      }),
    );
  }

  status(connectorId: string): Effect.Effect<BrokerStatus> {
    const stateRef = this.state;
    return Effect.gen(function* () {
      const brokerState = yield* SynchronizedRef.get(stateRef);
      const now = yield* Clock.currentTimeMillis;
      if (brokerState._tag === "Stopped") return emptyStatus(connectorId);
      const mailbox = brokerState.mailboxes.get(connectorId);
      if (!mailbox) return emptyStatus(connectorId);
      const state = yield* SynchronizedRef.get(mailbox.state);
      if (state._tag === "Stopped") return emptyStatus(connectorId);
      const counts = commandCounts(state.pending);
      if (!state.connection) return { ...emptyStatus(connectorId), ...counts };
      return {
        ...state.connection,
        connected: now - state.connection.lastSeenAt < CONNECTOR_LEASE_DEADLINE_MS,
        ...counts,
      } satisfies BrokerStatus;
    });
  }

  get stop(): Effect.Effect<void> {
    const stateRef = this.state;
    return Effect.gen(function* () {
      const entries = yield* SynchronizedRef.modify(stateRef, (state) =>
        state._tag === "Stopped"
          ? [new Map<string, Mailbox>(), state]
          : [state.mailboxes, { _tag: "Stopped" } as const],
      );
      yield* Effect.forEach(entries.values(), stopMailbox, { discard: true });
    });
  }
}

const makeMailbox = Effect.all({
  queue: Queue.dropping<WireCommand>(MAX_ADMITTED_COMMANDS_PER_CONNECTOR),
  delivery: Semaphore.make(1),
  state: SynchronizedRef.make<MailboxState>({
    _tag: "Active",
    pending: new Map(),
    connection: undefined,
  }),
  stopped: Deferred.make<void>(),
});

const connectorBusy = (connectorId: string): CommandRejected =>
  new CommandRejected({
    code: "connector-busy",
    message:
      `Chrome connector ${shortId(connectorId)} already has ` +
      `${MAX_ADMITTED_COMMANDS_PER_CONNECTOR} admitted commands`,
  });

const rejectFailedOffer = (
  mailbox: Mailbox,
  commandId: string,
  connectorId: string,
): Effect.Effect<never, BridgeStopped | CommandRejected> =>
  SynchronizedRef.modify(mailbox.state, (state) => {
    if (state._tag === "Stopped") return ["stopped", state] as const;
    const pending = new Map(state.pending);
    pending.delete(commandId);
    return ["busy", { ...state, pending }] as const;
  }).pipe(
    Effect.flatMap(
      (reason): Effect.Effect<never, BridgeStopped | CommandRejected> =>
        reason === "stopped"
          ? Effect.fail<BridgeStopped | CommandRejected>(
              new BridgeStopped({ message: "Chrome connector mailbox stopped" }),
            )
          : Effect.fail<BridgeStopped | CommandRejected>(connectorBusy(connectorId)),
    ),
  );

const outcomeUnknown = (command: WireCommand, reason: string): CommandOutcomeUnknown =>
  new CommandOutcomeUnknown({
    message:
      `Chrome command ${command.id} was already delivered when ${reason}. ` +
      "It may have completed and will not be repeated.",
    cause: reason,
  });

const timeoutFailure = (
  mailbox: Mailbox,
  command: WireCommand,
  timeoutMs: number,
): Effect.Effect<never, CommandTimeout | CommandOutcomeUnknown> =>
  withdrawQueued(mailbox, command.id).pipe(
    Effect.flatMap((deadline): Effect.Effect<never, CommandTimeout | CommandOutcomeUnknown> => {
      if (deadline === "outcome-unknown") {
        return Effect.fail(outcomeUnknown(command, `the ${timeoutMs}ms reply deadline expired`));
      }
      return Effect.fail(
        new CommandTimeout({
          timeoutMs,
          message: `Chrome command timed out before delivery after ${timeoutMs}ms`,
        }),
      );
    }),
  );

const interruptedFailure = (
  mailbox: Mailbox,
  command: WireCommand,
  cause: Cause.Cause<BridgeFailure>,
): Effect.Effect<never, BridgeFailure> =>
  withdrawQueued(mailbox, command.id).pipe(
    Effect.flatMap((delivery) =>
      delivery === "before-delivery"
        ? Effect.failCause(cause)
        : Effect.fail(outcomeUnknown(command, "its caller cancelled the request")),
    ),
  );

const withdrawQueued = (
  mailbox: Mailbox,
  commandId: string,
): Effect.Effect<"before-delivery" | "outcome-unknown"> =>
  SynchronizedRef.modify(mailbox.state, (state) => {
    if (state._tag === "Stopped") return ["outcome-unknown", state] as const;
    const current = state.pending.get(commandId);
    if (!current || current.phase !== "queued") return ["outcome-unknown", state] as const;
    const pending = new Map(state.pending);
    pending.delete(commandId);
    return ["before-delivery", { ...state, pending }] as const;
  });

const stopMailbox = (mailbox: Mailbox): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* SynchronizedRef.modify(mailbox.state, (state) =>
      state._tag === "Stopped"
        ? [new Map<string, Pending>(), state]
        : [state.pending, { _tag: "Stopped" } as const],
    );
    yield* Deferred.succeed(mailbox.stopped, undefined);
    yield* Effect.forEach(
      pending.values(),
      ({ command, phase, reply }) =>
        Deferred.fail(
          reply,
          phase !== "queued"
            ? outcomeUnknown(command, "the connector mailbox stopped")
            : new BridgeStopped({ message: "Chrome bridge stopped before command delivery" }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(mailbox.queue);
  });

const removePending = (mailbox: Mailbox, id: string): Effect.Effect<void> =>
  SynchronizedRef.update(mailbox.state, (state) => {
    if (state._tag === "Stopped") return state;
    const pending = new Map(state.pending);
    pending.delete(id);
    return { ...state, pending };
  });

const emptyStatus = (connectorId: string): BrokerStatus => ({
  connectorId,
  connected: false,
  queuedCommands: 0,
  pendingCommands: 0,
});

type CommandCounts = Pick<BrokerStatus, "queuedCommands" | "pendingCommands">;

const phaseBucket = {
  queued: "queuedCommands",
  executing: "pendingCommands",
  completing: "pendingCommands",
} as const satisfies Record<Pending["phase"], keyof CommandCounts>;

const commandCounts = (pending: ReadonlyMap<string, Pending>): CommandCounts =>
  [...pending.values()].reduce<CommandCounts>(
    (counts, command) => ({
      ...counts,
      [phaseBucket[command.phase]]: counts[phaseBucket[command.phase]] + 1,
    }),
    { queuedCommands: 0, pendingCommands: 0 },
  );

const shortId = (connectorId: string): string => connectorId.slice(0, 8);
