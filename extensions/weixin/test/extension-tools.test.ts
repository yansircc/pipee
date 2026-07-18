import { expect, it } from "@effect/vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import weixinExtension from "../extensions/weixin.ts";

it("registers global default and proactive send tools without a caller-controlled session id", () => {
  const tools: Array<{ readonly name: string; readonly parameters: unknown }> = [];
  weixinExtension({
    registerTool: (tool: { readonly name: string; readonly parameters: unknown }) => {
      tools.push(tool);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI);

  expect(tools.map((tool) => tool.name)).toEqual([
    "weixin_connect",
    "weixin_set_default",
    "weixin_send",
    "weixin_disconnect",
    "weixin_logout",
    "weixin_status",
  ]);
  const send = tools.find((tool) => tool.name === "weixin_send")?.parameters as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  expect(Object.keys(send.properties ?? {})).toEqual(["text"]);
});
