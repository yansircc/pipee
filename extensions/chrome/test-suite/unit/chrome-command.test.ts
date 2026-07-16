import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromeCommandCompletions, parseChromeCommand } from "../../src/pi/chrome-command.js";

it.effect("parses the command surface into a closed tagged algebra", () =>
  Effect.gen(function* () {
    expect(yield* parseChromeCommand("")).toEqual({ _tag: "Status" });
    expect(yield* parseChromeCommand("authorize")).toEqual({
      _tag: "Authorize",
      authorization: { _tag: "Indefinite" },
    });
    expect(yield* parseChromeCommand("authorize 15m")).toEqual({
      _tag: "Authorize",
      authorization: { _tag: "Timed", minutes: 15 },
    });
    expect(yield* parseChromeCommand("background on")).toEqual({
      _tag: "SetBackground",
      enabled: true,
    });
    expect(chromeCommandCompletions("background ").map(({ value }) => value)).toEqual([
      "background on",
      "background off",
    ]);
  }),
);

it.effect(
  "rejects unknown commands, invalid arity, and non-integral durations at the boundary",
  () =>
    Effect.gen(function* () {
      yield* parseChromeCommand("authorize 1.5").pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => expect(error.message).toContain("whole number"))),
      );
      yield* parseChromeCommand("status extra").pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => expect(error.message).toContain("Invalid arguments")),
        ),
      );
      yield* parseChromeCommand("missing value").pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => expect(error.message).toContain("Unknown /chrome command")),
        ),
      );
    }),
);
