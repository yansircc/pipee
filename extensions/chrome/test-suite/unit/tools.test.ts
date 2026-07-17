import { describe, expect, it, vi } from "vite-plus/test";
import { ACTION_VERBS } from "../../src/protocol/action-graph.js";
import {
  ACTION_TOOL_NAME_BY_VERB,
  ATOMIC_TOOL_DESCRIPTORS,
  ATOMIC_TOOL_PROFILES,
} from "../../src/protocol/operation-contract.js";
import {
  CHROME_ATOMIC_TOOL_NAMES,
  CHROME_DEFAULT_TOOL_NAMES,
  CHROME_TOOL_NAMES,
  activateChromeTools,
  enableChromeProfile,
  registerChromeTools,
  revokeChromeTools,
} from "../../src/pi/tools.js";

describe("atomic public tool surface", () => {
  it("derives every registration, profile, and action verb from operation descriptors", async () => {
    const registered: Array<Record<string, unknown>> = [];
    let activeTools = ["read"];
    const pi = {
      registerTool: (tool: Record<string, unknown>) => registered.push(tool),
      getActiveTools: () => activeTools,
      setActiveTools: (tools: Array<string>) => {
        activeTools = tools;
      },
    };
    const execute = vi.fn();
    const enableProfile = vi.fn((profile: "network") => {
      activeTools = enableChromeProfile(activeTools, profile);
      return Promise.resolve({
        content: [{ type: "text" as const, text: "enabled" }],
        details: { profile },
      });
    });
    const readStatus = vi.fn(() =>
      Promise.resolve({ content: [{ type: "text" as const, text: "ready" }], details: {} }),
    );

    registerChromeTools(pi as never, execute, enableProfile as never, readStatus as never);

    expect(ATOMIC_TOOL_DESCRIPTORS).toHaveLength(25);
    expect(new Set(CHROME_ATOMIC_TOOL_NAMES).size).toBe(25);
    expect(registered.map((tool) => tool.name)).toEqual(CHROME_TOOL_NAMES);
    expect(registered.every((tool) => typeof tool.parameters === "object")).toBe(true);
    expect(ATOMIC_TOOL_PROFILES.core).toEqual([
      "chrome_snapshot",
      "chrome_read",
      "chrome_navigate",
      "chrome_click",
      "chrome_fill",
      "chrome_press",
    ]);
    expect(Object.keys(ACTION_TOOL_NAME_BY_VERB).sort()).toEqual([...ACTION_VERBS].sort());

    const click = registered.find((tool) => tool.name === "chrome_click")!;
    const clickSchema = JSON.stringify(click.parameters);
    expect(clickSchema).toContain('"ref"');
    expect(clickSchema).not.toContain('"op"');
    expect(clickSchema).not.toContain('"operation"');

    expect(activateChromeTools(["read", "chrome_console"])).toEqual([
      "read",
      ...CHROME_DEFAULT_TOOL_NAMES,
    ]);
    expect(enableChromeProfile(["read", ...CHROME_DEFAULT_TOOL_NAMES], "network")).toEqual([
      "read",
      ...CHROME_DEFAULT_TOOL_NAMES,
      ...ATOMIC_TOOL_PROFILES.network,
    ]);
    expect(revokeChromeTools(["read", ...CHROME_TOOL_NAMES])).toEqual(["read"]);

    activeTools = activateChromeTools(activeTools);
    const enable = registered.find((tool) => tool.name === "chrome_enable")!;
    const result = await (
      enable.execute as (id: string, input: { profile: "network" }) => Promise<unknown>
    )("enable", { profile: "network" });
    expect(activeTools).toEqual([
      "read",
      ...CHROME_DEFAULT_TOOL_NAMES,
      ...ATOMIC_TOOL_PROFILES.network,
    ]);
    expect(result).toMatchObject({ details: { profile: "network" } });
    expect(enableProfile).toHaveBeenCalledWith("network", undefined, undefined);
  });
});
