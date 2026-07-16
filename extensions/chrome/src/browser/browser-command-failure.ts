import { CommandOutcomeUnknown, CommandRejected } from "../core/errors.js";
import { makeWireFailureResult } from "../protocol/codec.js";
import type { JsonValue } from "../protocol/json-value.js";
import type { WireResult } from "../protocol/schema.js";

export class BrowserRejected extends Error {
  readonly name = "BrowserRejected";

  readonly code: string;
  readonly details?: JsonValue;

  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly code?: string;
      readonly details?: JsonValue;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? "browser-operation";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class BrowserOutcomeUnknown extends Error {
  readonly name = "BrowserOutcomeUnknown";
}

export const makeBrowserFailureResult = (
  commandId: string,
  error: BrowserRejected | BrowserOutcomeUnknown,
): WireResult =>
  error instanceof BrowserOutcomeUnknown
    ? makeWireFailureResult(
        commandId,
        new CommandOutcomeUnknown({ message: error.message, cause: error.cause }),
      )
    : makeWireFailureResult(
        commandId,
        new CommandRejected({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
