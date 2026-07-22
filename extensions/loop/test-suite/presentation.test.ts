import { expect, it } from "@effect/vitest";
import type { Loop } from "../src/domain/model.js";
import { projectLoopArtifact, projectLoopLivePresentation } from "../src/pi/presentation.js";

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
  const document = projectLoopArtifact(loop, "Loop created");
  expect(document).toMatchObject({
    contract: "pipee/presentation@1",
    title: "Loop automation",
    summary: "Loop created",
    tone: "info",
    icon: "automation",
    status: { text: "Active", tone: "success" },
  });
  if (document.body?.type !== "group") throw new Error("expected body group");
  expect(document.body.children[0]).toMatchObject({ text: "Build monitor" });
  expect(document.body.children[1]).toMatchObject({ text: "Inspect the build" });
});

it("projects a generic companion surface without a host-owned Loop renderer", () => {
  expect(
    projectLoopLivePresentation({
      kind: "pi-loop/status",
      version: 1,
      sessionId: "session-1",
      observedAt: 1_000,
      loops: [],
    }),
  ).toEqual({
    contract: "pipee/presentation@1",
    title: "Automations",
    summary: "No session automations",
    tone: "neutral",
    icon: "automation",
    status: { text: "0", tone: "neutral" },
  });
});
