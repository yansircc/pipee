import { describe, expect, it } from "@effect/vitest";
import type { WebSurfaceSessionContext } from "@pi-suite/companion-contracts/web-surface";
import { aggregateOwnedLoops, type LoopWebProjection } from "../src/web/model.js";

const session = (
  sessionId: string,
  cwd: string,
  projectRoot: string | null,
): WebSurfaceSessionContext => ({
  sessionId,
  cwd,
  projectRoot,
  name: sessionId,
  modified: "2026-01-01T00:00:00.000Z",
});

const view = (
  sessionId: string,
  retention: "session" | "project",
  id = "loop-1",
): LoopWebProjection => ({
  sessionId,
  observedAt: 1,
  loops: [
    {
      id,
      prompt: "check",
      enabled: true,
      retention,
      schedule: { _tag: "Dynamic" },
      phase: { _tag: "Scheduled" },
    },
  ],
});

describe("Loop cross-Session projection", () => {
  it("keeps Session loops separate", () => {
    const left = session("left", "/repo", "/repo");
    const right = session("right", "/repo", "/repo");
    expect(
      aggregateOwnedLoops([
        { session: left, view: view(left.sessionId, "session") },
        { session: right, view: view(right.sessionId, "session") },
      ]),
    ).toHaveLength(2);
  });

  it("deduplicates Project loops by real project owner and chooses one stable dispatch Session", () => {
    const left = session("a-session", "/repo/worktree", "/repo");
    const right = session("z-session", "/repo", "/repo");
    const aggregated = aggregateOwnedLoops([
      { session: right, view: view(right.sessionId, "project") },
      { session: left, view: view(left.sessionId, "project") },
    ]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]).toMatchObject({
      key: "project:/repo:loop-1",
      session: { sessionId: "a-session" },
    });
  });
});
