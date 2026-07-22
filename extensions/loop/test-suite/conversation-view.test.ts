import { expect, it } from "@effect/vitest";
import type { Loop } from "../src/domain/model.js";
import { projectLoopConversationView } from "../src/pi/conversation-view.js";
import { projectLoopCompanionView } from "../src/pi/companion-view.js";

it("projects an extension-owned loop card without runtime state", () => {
  const loop: Loop = {
    _tag: "Interval",
    id: "daily",
    prompt: "Inspect the build",
    retention: "session",
    createdAt: 1,
    enabled: true,
    manualCursor: 0,
    label: "Build monitor",
    spec: { periodMs: 60_000, jitterFraction: 0, jitterCapMs: 0 },
    phase: { _tag: "Waiting", dueAt: 1_800_000_000_000, cursor: 0 },
  };
  const view = projectLoopConversationView(loop, "Loop created");
  expect(view).toMatchObject({
    contract: "pipee/conversation-view@1",
    label: "Loop automation",
    tone: "info",
  });
  if (view.root.type !== "group") throw new Error("expected root group");
  expect(view.root.children[0]).toMatchObject({
    children: [{ text: "Build monitor" }, { text: "Active", tone: "success" }],
  });
  expect(view.root.children[1]).toMatchObject({ text: "Inspect the build" });
});

it("projects a generic companion surface without a host-owned Loop renderer", () => {
  expect(
    projectLoopCompanionView({
      kind: "pi-loop/status",
      version: 1,
      sessionId: "session-1",
      observedAt: 1_000,
      loops: [],
    }),
  ).toEqual({
    contract: "pipee/companion-view@1",
    label: "Automations",
    state: "0",
    summary: "No session automations",
    tone: "neutral",
    glyph: "automation",
  });
});
