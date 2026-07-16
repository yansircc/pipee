import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AuthorizationFailure } from "../core/errors.js";
import { PairingId } from "../protocol/schema.js";

const MAX_TIMED_AUTHORIZATION_MINUTES = 24 * 60;

export type AuthorizationRequest =
  | { readonly _tag: "Indefinite" }
  | { readonly _tag: "Timed"; readonly minutes: number };

export type ChromeCommand =
  | { readonly _tag: "Authorize"; readonly authorization: AuthorizationRequest }
  | { readonly _tag: "Revoke" }
  | { readonly _tag: "Status" }
  | { readonly _tag: "Doctor" }
  | { readonly _tag: "Cleanup" }
  | { readonly _tag: "Onboard" }
  | { readonly _tag: "Unpair" }
  | { readonly _tag: "Forget" }
  | { readonly _tag: "WebAttach"; readonly offer: string }
  | { readonly _tag: "WebAssert"; readonly pairingId: string }
  | { readonly _tag: "WebDetach"; readonly pairingId: string }
  | { readonly _tag: "WebTerminal" }
  | { readonly _tag: "SetBackground"; readonly enabled: boolean };

const COMPLETIONS = [
  "authorize",
  "revoke",
  "status",
  "doctor",
  "cleanup",
  "onboard",
  "unpair",
  "forget",
  "background on",
  "background off",
] as const;

export const chromeCommandCompletions = (prefix: string) =>
  COMPLETIONS.filter((value) => value.startsWith(prefix.trimStart().toLowerCase())).map(
    (value) => ({ value, label: value }),
  );

const failure = (message: string) => new AuthorizationFailure({ message });

const requireNoOperands = (
  command: string,
  operands: ReadonlyArray<string>,
  value: ChromeCommand,
): Effect.Effect<ChromeCommand, AuthorizationFailure> =>
  operands.length === 0
    ? Effect.succeed(value)
    : Effect.fail(failure(`Invalid arguments for /chrome ${command}`));

const parseAuthorization = (
  operands: ReadonlyArray<string>,
): Effect.Effect<ChromeCommand, AuthorizationFailure> => {
  if (operands.length > 1) {
    return Effect.fail(failure("Invalid arguments for /chrome authorize"));
  }
  const value = operands[0]?.toLowerCase() ?? "indefinite";
  if (value === "indefinite") {
    return Effect.succeed({ _tag: "Authorize", authorization: { _tag: "Indefinite" } });
  }
  const duration = value.endsWith("m") ? value.slice(0, -1) : value;
  const minutes = /^[1-9][0-9]*$/.test(duration) ? Number(duration) : Number.NaN;
  return Number.isSafeInteger(minutes) && minutes <= MAX_TIMED_AUTHORIZATION_MINUTES
    ? Effect.succeed({ _tag: "Authorize", authorization: { _tag: "Timed", minutes } })
    : Effect.fail(
        failure(
          `Authorization duration must be a whole number between 1 and ${MAX_TIMED_AUTHORIZATION_MINUTES} minutes, or 'indefinite'.`,
        ),
      );
};

const parseBackground = (
  operands: ReadonlyArray<string>,
): Effect.Effect<ChromeCommand, AuthorizationFailure> => {
  if (operands.length !== 1) {
    return Effect.fail(failure("Invalid arguments for /chrome background"));
  }
  const value = operands[0]?.toLowerCase();
  return value === "on" || value === "off"
    ? Effect.succeed({ _tag: "SetBackground", enabled: value === "on" })
    : Effect.fail(failure("Background mode must be 'on' or 'off'."));
};

const parseWebPairingId = (
  command: "web-assert" | "web-detach",
  operands: ReadonlyArray<string>,
): Effect.Effect<ChromeCommand, AuthorizationFailure> =>
  operands.length === 1 && Schema.is(PairingId)(operands[0])
    ? Effect.succeed({
        _tag: command === "web-assert" ? "WebAssert" : "WebDetach",
        pairingId: operands[0],
      })
    : Effect.fail(failure(`Invalid arguments for /chrome ${command}`));

export const parseChromeCommand = (
  input: string,
): Effect.Effect<ChromeCommand, AuthorizationFailure> => {
  const normalized = input.trim();
  const [command = "status", ...operands] = normalized ? normalized.split(/\s+/) : [];
  switch (command.toLowerCase()) {
    case "authorize":
      return parseAuthorization(operands);
    case "revoke":
      return requireNoOperands(command, operands, { _tag: "Revoke" });
    case "status":
      return requireNoOperands(command, operands, { _tag: "Status" });
    case "doctor":
      return requireNoOperands(command, operands, { _tag: "Doctor" });
    case "cleanup":
      return requireNoOperands(command, operands, { _tag: "Cleanup" });
    case "onboard":
      return requireNoOperands(command, operands, { _tag: "Onboard" });
    case "unpair":
      return requireNoOperands(command, operands, { _tag: "Unpair" });
    case "forget":
      return requireNoOperands(command, operands, { _tag: "Forget" });
    case "web-attach":
      return operands.length === 1
        ? Effect.succeed({ _tag: "WebAttach", offer: operands[0]! })
        : Effect.fail(failure("Invalid arguments for /chrome web-attach"));
    case "web-assert":
      return parseWebPairingId("web-assert", operands);
    case "web-detach":
      return parseWebPairingId("web-detach", operands);
    case "web-terminal":
      return requireNoOperands(command, operands, { _tag: "WebTerminal" });
    case "background":
      return parseBackground(operands);
    default:
      return Effect.fail(failure(`Unknown /chrome command: ${command}`));
  }
};
