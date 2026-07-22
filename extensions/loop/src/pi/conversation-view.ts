import type { ConversationView } from "@pipee/companion-contracts/conversation-view";
import type { Loop } from "../domain/model.js";

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

export const projectLoopConversationView = (loop: Loop, event: string): ConversationView => ({
  contract: "pipee/conversation-view@1",
  label: "Loop automation",
  tone: loop.enabled ? "info" : "warning",
  root: {
    type: "group",
    direction: "column",
    gap: "medium",
    children: [
      {
        type: "group",
        direction: "row",
        gap: "small",
        children: [
          { type: "text", text: loop.label ?? event, variant: "title" },
          {
            type: "badge",
            text: loop.enabled ? "Active" : "Paused",
            tone: loop.enabled ? "success" : "warning",
          },
        ],
      },
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
