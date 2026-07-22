import type { CompanionView } from "@pipee/companion-contracts/companion-view";
import type { ConversationViewNode } from "@pipee/companion-contracts/conversation-view";
import type { LoopProjection, LoopStatusProjection } from "@pipee/companion-contracts/loop";

const scheduleText = (loop: LoopProjection): string => {
  if (loop.schedule._tag === "Interval")
    return `every ${Math.round(loop.schedule.periodMs / 1_000)}s`;
  if (loop.schedule._tag === "Cron")
    return `${loop.schedule.expression} · ${loop.schedule.timeZone}`;
  if (loop.schedule._tag === "Once") return "once";
  return "agent scheduled";
};

const loopDetails = (status: LoopStatusProjection): ConversationViewNode | undefined => {
  if (status.loops.length === 0) return undefined;
  const visible = status.loops.slice(0, 12);
  return {
    type: "group",
    direction: "column",
    gap: "small",
    children: [
      ...visible.map(
        (loop): ConversationViewNode => ({
          type: "group",
          direction: "column",
          gap: "small",
          children: [
            { type: "text", text: loop.label ?? loop.prompt, variant: "body" },
            {
              type: "text",
              text: `${scheduleText(loop)} · ${loop.retention} · ${loop.enabled ? "active" : "paused"} · ${loop.id}`,
              variant: "caption",
            },
          ],
        }),
      ),
      ...(visible.length === status.loops.length
        ? []
        : [
            {
              type: "text" as const,
              text: `${status.loops.length - visible.length} more automations`,
              variant: "caption" as const,
            },
          ]),
    ],
  };
};

export const projectLoopCompanionView = (status: LoopStatusProjection): CompanionView => {
  const active = status.loops.filter((loop) => loop.enabled).length;
  const details = loopDetails(status);
  return {
    contract: "pipee/companion-view@1",
    label: "Automations",
    state: String(status.loops.length),
    summary:
      status.loops.length === 0
        ? "No session automations"
        : `${active} active · ${status.loops.length - active} paused`,
    tone: active > 0 ? "info" : "neutral",
    glyph: "automation",
    ...(details === undefined ? {} : { details }),
  };
};
