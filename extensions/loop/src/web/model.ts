import type { WebSurfaceSessionContext } from "@pi-suite/companion-contracts/web-surface";

export type LoopWebProjectionItem = {
  id: string;
  prompt: string;
  label?: string;
  enabled: boolean;
  retention: "session" | "project";
  schedule: { _tag: string; periodMs?: number; expression?: string; timeZone?: string };
  phase: { _tag: string; dueAt?: number };
};

export type LoopWebProjection = {
  sessionId: string;
  observedAt: number;
  loops: LoopWebProjectionItem[];
};

export type OwnedLoop = {
  key: string;
  session: WebSurfaceSessionContext;
  loop: LoopWebProjectionItem;
};

export const aggregateOwnedLoops = (
  projections: ReadonlyArray<{
    readonly session: WebSurfaceSessionContext;
    readonly view: LoopWebProjection;
  }>,
): ReadonlyArray<OwnedLoop> => {
  const aggregated = new Map<string, OwnedLoop>();
  for (const { session, view } of projections) {
    for (const loop of view.loops) {
      const owner =
        loop.retention === "project" ? session.projectRoot || session.cwd : session.sessionId;
      const key = `${loop.retention}:${owner}:${loop.id}`;
      const previous = aggregated.get(key);
      if (
        previous === undefined ||
        session.sessionId.localeCompare(previous.session.sessionId) < 0
      ) {
        aggregated.set(key, { key, session, loop });
      }
    }
  }
  return [...aggregated.values()].sort(
    (left, right) =>
      (left.loop.phase.dueAt ?? Number.POSITIVE_INFINITY) -
        (right.loop.phase.dueAt ?? Number.POSITIVE_INFINITY) ||
      left.loop.id.localeCompare(right.loop.id),
  );
};
