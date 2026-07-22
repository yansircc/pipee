import { expect, it } from "vite-plus/test";
import { projectChromeArtifact, projectChromeLivePresentation } from "../../src/pi/presentation.js";

it("projects a Chrome status card from the extension-owned status fact", () => {
  expect(
    projectChromeArtifact({
      kind: "pi-chrome/status",
      version: 3,
      state: "ready",
      bridge: "running",
      extensionDirectory: "/fixture",
      connector: { id: "connector", label: "Primary profile", connected: true },
    }),
  ).toMatchObject({
    contract: "pipee/presentation@1",
    title: "Chrome",
    summary: "Primary profile",
    tone: "success",
    status: { text: "Ready", tone: "success" },
    body: {
      children: [
        { text: "Browser connection" },
        { children: [{ value: "running" }, { value: "Primary profile" }, { value: "Connected" }] },
      ],
    },
  });
});

it("projects the generic companion surface beside typed Chrome status", () => {
  expect(
    projectChromeLivePresentation({
      kind: "pi-chrome/status",
      version: 3,
      state: "ready",
      bridge: "running",
      extensionDirectory: "/fixture",
      connector: { id: "connector", label: "Primary profile", connected: true },
    }),
  ).toEqual({
    contract: "pipee/presentation@1",
    title: "Chrome",
    summary: "Primary profile",
    tone: "success",
    icon: "browser",
    status: { text: "Ready", tone: "success" },
  });
});
