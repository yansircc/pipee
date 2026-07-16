import { expect, it } from "@effect/vitest";
import { COMMAND_DEADLINES_MS } from "../../src/protocol/bridge-contract.js";
import { browserExecutionTimeoutMs } from "../../src/protocol/timeout.js";

const typeText = (text: string) =>
  ({
    domain: "input",
    call: { operation: { kind: "type", text } },
  }) as const;

it("budgets text input by Unicode code point like the input generator", () => {
  const oneAscii = browserExecutionTimeoutMs(typeText("x"));
  const oneAstral = browserExecutionTimeoutMs(typeText("😀"));
  const twoCodePoints = browserExecutionTimeoutMs(typeText("e\u0301"));

  expect(oneAstral).toBe(oneAscii);
  expect(twoCodePoints).toBe(
    COMMAND_DEADLINES_MS.textInputBase + 2 * COMMAND_DEADLINES_MS.textInputPerCharacter,
  );
});

it("adds the page observation budget only when navigation requests a snapshot", () => {
  const navigate = {
    domain: "page",
    call: {
      operation: { kind: "navigate", url: "https://example.test", timeoutMs: 5_000 },
    },
  } as const;
  const composed = {
    domain: "page",
    call: {
      operation: {
        kind: "navigate",
        url: "https://example.test",
        timeoutMs: 5_000,
        snapshot: { mode: "text" },
      },
    },
  } as const;

  expect(browserExecutionTimeoutMs(composed) - browserExecutionTimeoutMs(navigate)).toBe(
    COMMAND_DEADLINES_MS.defaultExecution,
  );
});
