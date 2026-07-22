import { expect, it } from "vite-plus/test";
import {
  projectChromeCompanionView,
  projectChromeConversationView,
} from "../../src/pi/conversation-view.js";

it("projects a Chrome status card from the extension-owned status fact", () => {
  expect(
    projectChromeConversationView({
      kind: "pi-chrome/status",
      version: 3,
      state: "ready",
      bridge: "running",
      extensionDirectory: "/fixture",
      connector: { id: "connector", label: "Primary profile", connected: true },
    }),
  ).toMatchObject({
    contract: "pipee/conversation-view@1",
    label: "Chrome",
    tone: "success",
    root: {
      children: [
        { children: [{ text: "Browser connection" }, { text: "Ready", tone: "success" }] },
        { children: [{ value: "running" }, { value: "Primary profile" }, { value: "Connected" }] },
      ],
    },
  });
});

it("projects the generic companion surface beside typed Chrome status", () => {
  expect(
    projectChromeCompanionView({
      kind: "pi-chrome/status",
      version: 3,
      state: "ready",
      bridge: "running",
      extensionDirectory: "/fixture",
      connector: { id: "connector", label: "Primary profile", connected: true },
    }),
  ).toEqual({
    contract: "pipee/companion-view@1",
    label: "Chrome",
    state: "Ready",
    summary: "Primary profile",
    tone: "success",
    glyph: "browser",
  });
});
