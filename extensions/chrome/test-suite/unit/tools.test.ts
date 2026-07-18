import { describe, expect, it, vi } from "vite-plus/test";
import { ACTION_VERBS } from "../../src/protocol/action-graph.js";
import {
  ACTION_TOOL_NAME_BY_VERB,
  ATOMIC_TOOL_DESCRIPTORS,
} from "../../src/protocol/operation-contract.js";
import {
  CHROME_ATOMIC_TOOL_NAMES,
  CHROME_TOOL_NAMES,
  registerChromeTools,
} from "../../src/pi/tools.js";

describe("atomic public tool surface", () => {
  it("registers every descriptor-derived leaf and status directly", () => {
    const registered: Array<Record<string, unknown>> = [];
    const pi = {
      registerTool: (tool: Record<string, unknown>) => registered.push(tool),
    };
    const execute = vi.fn();
    const readStatus = vi.fn(() =>
      Promise.resolve({ content: [{ type: "text" as const, text: "ready" }], details: {} }),
    );

    registerChromeTools(pi as never, execute, readStatus);

    expect(ATOMIC_TOOL_DESCRIPTORS).toHaveLength(25);
    expect(new Set(CHROME_ATOMIC_TOOL_NAMES).size).toBe(25);
    expect(registered.map((tool) => tool.name)).toEqual(CHROME_TOOL_NAMES);
    expect(Object.keys(ACTION_TOOL_NAME_BY_VERB).sort()).toEqual([...ACTION_VERBS].sort());

    const click = registered.find((tool) => tool.name === "chrome_click")!;
    const clickSchema = JSON.stringify(click.parameters);
    expect(clickSchema).toContain('"ref"');
    expect(clickSchema).not.toContain('"op"');
    expect(clickSchema).not.toContain('"operation"');
  });
});
