import { expect, it } from "@effect/vitest";
import { projectWeixinArtifact, projectWeixinLivePresentation } from "../src/presentation.ts";

it("projects a readable Weixin connection card", () => {
  expect(
    projectWeixinArtifact({
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
    contract: "pipee/presentation@1",
    title: "Weixin",
    summary: "wx-fixture",
    tone: "success",
    status: { text: "运行中", tone: "success" },
    body: {
      children: [
        { text: "微信连接" },
        { children: [{ value: "wx-fixture" }, { value: "session-1" }, { value: "可用" }] },
      ],
    },
  });
});

it("projects the generic companion surface beside typed Weixin status", () => {
  expect(
    projectWeixinLivePresentation({
      kind: "pi-weixin/status",
      version: 3,
      enabled: true,
      connected: true,
      phase: "Connected",
      sendReady: true,
      accountId: "wx-fixture",
    }),
  ).toEqual({
    contract: "pipee/presentation@1",
    title: "Weixin",
    summary: "wx-fixture",
    tone: "success",
    icon: "messages",
    status: { text: "运行中", tone: "success" },
  });
});
