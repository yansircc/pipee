import { expect, it } from "@effect/vitest";
import {
  projectWeixinCompanionView,
  projectWeixinConversationView,
} from "../src/conversation-view.ts";

it("projects a readable Weixin connection card", () => {
  expect(
    projectWeixinConversationView({
      kind: "pi-weixin/status",
      version: 3,
      enabled: true,
      connected: true,
      phase: "Connected",
      sendReady: true,
      accountId: "wx-fixture",
      defaultSessionId: "session-1",
    }),
  ).toMatchObject({
    contract: "pipee/conversation-view@1",
    label: "Weixin",
    tone: "success",
    root: {
      children: [
        { children: [{ text: "微信连接" }, { text: "运行中", tone: "success" }] },
        { children: [{ value: "wx-fixture" }, { value: "session-1" }, { value: "可用" }] },
      ],
    },
  });
});

it("projects the generic companion surface beside typed Weixin status", () => {
  expect(
    projectWeixinCompanionView({
      kind: "pi-weixin/status",
      version: 3,
      enabled: true,
      connected: true,
      phase: "Connected",
      sendReady: true,
      accountId: "wx-fixture",
    }),
  ).toEqual({
    contract: "pipee/companion-view@1",
    label: "Weixin",
    state: "运行中",
    summary: "wx-fixture",
    tone: "success",
    glyph: "messages",
  });
});
