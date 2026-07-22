import type {
  PresentationDocument,
  PresentationNode,
} from "@pipee/companion-contracts/presentation";
import type { Loop } from "../domain/model.js";
import type { LoopProjection, LoopStatusProjection } from "./status-contract.js";

const scheduleText = (loop: Loop): string => {
  if (loop._tag === "Cron") return `Cron ${loop.spec.expression}`;
  if (loop._tag === "Interval") return `Every ${Math.round(loop.spec.periodMs / 1_000)} seconds`;
  if (loop._tag === "Once") return "Run once";
  return "Agent scheduled";
};

const dueText = (loop: Loop): string =>
  loop.phase._tag === "Waiting"
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        loop.phase.dueAt,
      )
    : "Waiting for Agent";

export const projectLoopArtifact = (loop: Loop, event: string): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title: "Loop automation",
  summary: event,
  tone: loop.enabled ? "info" : "warning",
  icon: "automation",
  status: {
    text: loop.enabled ? "Active" : "Paused",
    tone: loop.enabled ? "success" : "warning",
  },
  body: {
    type: "group",
    direction: "column",
    gap: "medium",
    children: [
      { type: "text", text: loop.label ?? event, variant: "title" },
      { type: "text", text: loop.prompt, variant: "body" },
      {
        type: "group",
        direction: "row",
        gap: "medium",
        children: [
          { type: "field", label: "Schedule", value: scheduleText(loop) },
          { type: "field", label: "Next run", value: dueText(loop) },
          { type: "field", label: "Scope", value: loop.retention },
        ],
      },
    ],
  },
});

const scheduleSummary = (loop: LoopProjection): string => {
  if (loop.schedule._tag === "Interval")
    return `every ${Math.round(loop.schedule.periodMs / 1_000)}s`;
  if (loop.schedule._tag === "Cron")
    return `${loop.schedule.expression} · ${loop.schedule.timeZone}`;
  if (loop.schedule._tag === "Once") return "once";
  return "agent scheduled";
};

const loopDetails = (status: LoopStatusProjection): PresentationNode | undefined => {
  if (status.loops.length === 0) return undefined;
  const visible = status.loops.slice(0, 12);
  return {
    type: "group",
    direction: "column",
    gap: "small",
    children: [
      ...visible.map(
        (loop): PresentationNode => ({
          type: "group",
          direction: "column",
          gap: "small",
          children: [
            { type: "text", text: loop.label ?? loop.prompt, variant: "body" },
            {
              type: "text",
              text: `${scheduleSummary(loop)} · ${loop.retention} · ${loop.enabled ? "active" : "paused"} · ${loop.id}`,
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

export const projectLoopLivePresentation = (status: LoopStatusProjection): PresentationDocument => {
  const active = status.loops.filter((loop) => loop.enabled).length;
  const body = loopDetails(status);
  return {
    contract: "pipee/presentation@1",
    title: "Automations",
    summary:
      status.loops.length === 0
        ? "No session automations"
        : `${active} active · ${status.loops.length - active} paused`,
    tone: active > 0 ? "info" : "neutral",
    icon: "automation",
    status: { text: String(status.loops.length), tone: active > 0 ? "info" : "neutral" },
    ...(body === undefined ? {} : { body }),
  };
};
