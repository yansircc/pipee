import * as Effect from "effect/Effect";
import { validateOperationSuccess } from "../protocol/operation-contract.js";
import type { ProfileConnector, WireCommand, WireResult } from "../protocol/schema.js";
import {
  BrowserOutcomeUnknown,
  BrowserRejected,
  makeBrowserFailureResult,
} from "./browser-command-failure.js";
import type { LoadedCommandJournalEntry } from "./command-journal.js";

export type BrowserCommandDispatch = (command: WireCommand) => Promise<unknown>;

export const settleBrowserCommand = (
  command: WireCommand,
  dispatch: BrowserCommandDispatch,
): Effect.Effect<WireResult> =>
  Effect.tryPromise({
    try: () => dispatch(command),
    catch: (cause) =>
      cause instanceof BrowserRejected || cause instanceof BrowserOutcomeUnknown
        ? cause
        : new BrowserRejected(cause instanceof Error ? cause.message : String(cause), { cause }),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(makeBrowserFailureResult(command.id, error)),
      onSuccess: (value) =>
        validateOperationSuccess(command, value).pipe(
          Effect.match({
            onFailure: (cause): WireResult =>
              makeBrowserFailureResult(
                command.id,
                new BrowserOutcomeUnknown(
                  `Browser operation ${command.domain} returned a value outside its result contract. ` +
                    "It may have changed Chrome and will not be repeated.",
                  { cause },
                ),
              ),
            onSuccess: (validated): WireResult => ({ id: command.id, ok: true, value: validated }),
          }),
        ),
    }),
  );

type RuntimeEffect<Value> = Effect.Effect<Value, unknown>;

export type ConnectorRuntimePort = {
  readonly loadConnector: RuntimeEffect<ProfileConnector>;
  readonly loadJournal: RuntimeEffect<LoadedCommandJournalEntry | undefined>;
  readonly deliverResult: (result: WireResult, connector: ProfileConnector) => RuntimeEffect<void>;
  readonly clearJournal: RuntimeEffect<void>;
  readonly receiveCommand: (connector: ProfileConnector) => RuntimeEffect<WireCommand | undefined>;
  readonly recordExecuting: (command: WireCommand) => RuntimeEffect<void>;
  readonly executeCommand: (command: WireCommand) => RuntimeEffect<WireResult>;
  readonly recordResult: (command: WireCommand, result: WireResult) => RuntimeEffect<void>;
};

// Polling is interruptible so a connector-route change can wake a stale long poll. Once a command
// has been received, execution and result persistence are one uninterruptible ownership turn:
// restarting the poll loop must not orphan a live Chrome Promise and admit a second command.
export const connectorRuntimeStep = (port: ConnectorRuntimePort): RuntimeEffect<void> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const connector = yield* restore(port.loadConnector);
      const journal = yield* restore(port.loadJournal);
      if (journal) {
        yield* restore(port.deliverResult(journal.result, connector));
        yield* port.clearJournal;
        return;
      }

      const command = yield* restore(port.receiveCommand(connector));
      if (!command) return;
      yield* port.recordExecuting(command);
      const result = yield* port.executeCommand(command);
      yield* port.recordResult(command, result);
    }),
  );
