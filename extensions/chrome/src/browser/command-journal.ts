import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CommandOutcomeUnknown } from "../core/errors.js";
import { makeWireFailureResult } from "../protocol/codec.js";
export {
  classifyResultDelivery,
  type ResultDeliveryDecision,
} from "../protocol/bridge-contract.js";
import { validateOperationSuccess } from "../protocol/operation-contract.js";
import { encodeJsonTransport } from "../protocol/json-transport.js";
import { protocolFingerprint } from "../protocol/protocol-fingerprint.js";
import {
  ProtocolFingerprint,
  WireCommand,
  WireResult,
  type WireCommand as WireCommandType,
  type WireResult as WireResultType,
} from "../protocol/schema.js";

const COMMAND_JOURNAL_STORAGE_KEY = "piChromeCommandJournal";
const COMMAND_JOURNAL_VERSION = 1 as const;

const StableJournalEnvelope = Schema.Struct({
  version: Schema.Literal(COMMAND_JOURNAL_VERSION),
  protocolFingerprint: ProtocolFingerprint,
  commandId: Schema.NonEmptyString,
  state: Schema.Literals(["executing", "result"]),
  payload: Schema.Unknown,
});

const ExecutingPayload = Schema.Struct({ command: WireCommand });
const CurrentResultPayload = Schema.Struct({
  kind: Schema.Literal("current"),
  command: WireCommand,
  result: WireResult,
});
const RecoveredResultPayload = Schema.Struct({
  kind: Schema.Literal("recovered"),
  result: WireResult,
});
const ResultPayload = Schema.Union([CurrentResultPayload, RecoveredResultPayload]);

type StableJournalEnvelope = Schema.Schema.Type<typeof StableJournalEnvelope>;
export type LoadedCommandJournalEntry = {
  readonly state: "result";
  readonly result: WireResultType;
};

export class CommandJournalFailure extends Data.TaggedError("CommandJournalFailure")<{
  readonly operation: "load" | "save" | "clear";
  readonly message: string;
  readonly cause?: unknown;
}> {}

const failure =
  (operation: CommandJournalFailure["operation"], message: string) => (cause: unknown) =>
    new CommandJournalFailure({ operation, message, cause });

const currentFingerprint = (operation: "load" | "save") =>
  protocolFingerprint.pipe(
    Effect.mapError(
      failure(operation, "Could not compute the command journal protocol fingerprint"),
    ),
  );

const persist = (entry: StableJournalEnvelope) =>
  Effect.tryPromise({
    try: () => chrome.storage.local.set({ [COMMAND_JOURNAL_STORAGE_KEY]: entry }),
    catch: failure("save", "Could not persist the Chrome command journal"),
  });

const remove = Effect.tryPromise({
  try: () => chrome.storage.local.remove(COMMAND_JOURNAL_STORAGE_KEY),
  catch: failure("clear", "Could not clear the Chrome command journal"),
});

const decodeAttempt = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.match({
      onFailure: (cause) => ({ _tag: "Invalid" as const, cause }),
      onSuccess: (decoded) => ({ _tag: "Valid" as const, decoded }),
    }),
  );

const extractCommandId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("commandId" in value)) return undefined;
  return typeof value.commandId === "string" && value.commandId.length > 0
    ? value.commandId
    : undefined;
};

const outcomeUnknown = (commandId: string, reason: string): WireResultType =>
  makeWireFailureResult(
    commandId,
    new CommandOutcomeUnknown({
      message:
        `Chrome command ${commandId} was interrupted or its durable contract changed. ` +
        "The operation may have completed and will not be repeated.",
      cause: reason,
    }),
  );

const recoveredEnvelope = (
  commandId: string,
  fingerprint: string,
  reason: string,
): { readonly envelope: StableJournalEnvelope; readonly entry: LoadedCommandJournalEntry } => {
  const result = outcomeUnknown(commandId, reason);
  return {
    envelope: {
      version: COMMAND_JOURNAL_VERSION,
      protocolFingerprint: fingerprint,
      commandId,
      state: "result",
      payload: { kind: "recovered", result },
    },
    entry: { state: "result", result },
  };
};

const recover = (commandId: string, fingerprint: string, reason: string) => {
  const recovered = recoveredEnvelope(commandId, fingerprint, reason);
  return persist(recovered.envelope).pipe(Effect.as(recovered.entry));
};

const loadCurrentResult = (
  envelope: StableJournalEnvelope,
  fingerprint: string,
): Effect.Effect<LoadedCommandJournalEntry, CommandJournalFailure> =>
  Effect.gen(function* () {
    const payload = yield* decodeAttempt(ResultPayload, envelope.payload);
    if (payload._tag === "Invalid") {
      return yield* recover(
        envelope.commandId,
        fingerprint,
        "current result payload could not be decoded",
      );
    }
    const decoded = payload.decoded;
    if (decoded.result.id !== envelope.commandId) {
      return yield* recover(
        envelope.commandId,
        fingerprint,
        "journal envelope and result ids disagree",
      );
    }
    if (decoded.kind === "recovered") {
      return decoded.result.ok || decoded.result.error._tag !== "CommandOutcomeUnknown"
        ? yield* recover(
            envelope.commandId,
            fingerprint,
            "recovered journal payload was not an outcome-unknown result",
          )
        : { state: "result", result: decoded.result };
    }
    if (decoded.command.id !== envelope.commandId) {
      return yield* recover(
        envelope.commandId,
        fingerprint,
        "journal envelope and command ids disagree",
      );
    }
    if (!decoded.result.ok) return { state: "result", result: decoded.result };
    const validated = yield* validateOperationSuccess(decoded.command, decoded.result.value).pipe(
      Effect.match({
        onFailure: () => ({ ok: false as const }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    );
    if (!validated.ok) {
      return yield* recover(
        envelope.commandId,
        fingerprint,
        "successful journal result does not match its command contract",
      );
    }
    return {
      state: "result",
      result: { ...decoded.result, value: validated.value },
    };
  });

export const loadCommandJournal: Effect.Effect<
  LoadedCommandJournalEntry | undefined,
  CommandJournalFailure
> = Effect.gen(function* () {
  const stored = yield* Effect.tryPromise({
    try: () => chrome.storage.local.get(COMMAND_JOURNAL_STORAGE_KEY),
    catch: failure("load", "Could not read the Chrome command journal"),
  });
  const value = stored[COMMAND_JOURNAL_STORAGE_KEY];
  if (value === undefined) return undefined;
  const fingerprint = yield* currentFingerprint("load");
  const commandId = extractCommandId(value);
  if (!commandId) {
    yield* Effect.logWarning(
      "pi-chrome cleared an unrecoverable command journal without a stable command id",
    );
    yield* remove;
    return undefined;
  }
  const decoded = yield* decodeAttempt(StableJournalEnvelope, value);
  if (decoded._tag === "Invalid") {
    return yield* recover(commandId, fingerprint, "stable journal envelope is invalid");
  }
  const envelope = decoded.decoded;
  if (envelope.protocolFingerprint !== fingerprint) {
    return yield* recover(commandId, fingerprint, "journal protocol fingerprint changed");
  }
  if (envelope.state === "executing") {
    const payload = yield* decodeAttempt(ExecutingPayload, envelope.payload);
    const reason =
      payload._tag === "Valid" && payload.decoded.command.id === commandId
        ? "MV3 worker stopped during command execution"
        : "executing journal payload is invalid";
    return yield* recover(commandId, fingerprint, reason);
  }
  return yield* loadCurrentResult(envelope, fingerprint);
});

export const recordCommandExecuting = (command: WireCommandType) =>
  currentFingerprint("save").pipe(
    Effect.flatMap((fingerprint) =>
      persist({
        version: COMMAND_JOURNAL_VERSION,
        protocolFingerprint: fingerprint,
        commandId: command.id,
        state: "executing",
        payload: { command },
      }),
    ),
  );

const resultForCommand = (
  command: WireCommandType,
  result: WireResultType,
): Effect.Effect<WireResultType, CommandJournalFailure> => {
  if (result.id !== command.id) {
    return Effect.fail(
      new CommandJournalFailure({
        operation: "save",
        message: "Could not persist a result for a different Chrome command",
        cause: { commandId: command.id, resultId: result.id },
      }),
    );
  }
  if (!result.ok) return Effect.succeed(result);
  return validateOperationSuccess(command, result.value).pipe(
    Effect.map((value): WireResultType => ({ ...result, value })),
    Effect.catch((cause) =>
      Effect.succeed(
        outcomeUnknown(
          command.id,
          `successful browser result violated its operation or JSON contract: ${cause.message}`,
        ),
      ),
    ),
  );
};

const transportSafeResult = (commandId: string, result: WireResultType) =>
  encodeJsonTransport("Chrome wire result", WireResult, result).pipe(
    Effect.match({
      onFailure: (cause) => outcomeUnknown(commandId, cause.message),
      onSuccess: ({ value }) => value,
    }),
  );

export const recordCommandResult = (command: WireCommandType, result: WireResultType) =>
  Effect.gen(function* () {
    const validated = yield* resultForCommand(command, result);
    const durable = yield* transportSafeResult(command.id, validated);
    const fingerprint = yield* currentFingerprint("save");
    yield* persist({
      version: COMMAND_JOURNAL_VERSION,
      protocolFingerprint: fingerprint,
      commandId: command.id,
      state: "result",
      payload: { kind: "current", command, result: durable },
    });
  });

export const clearCommandJournal = remove;
