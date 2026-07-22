import type { ChromeStatusProjection } from "@pipee/companion-contracts/chrome";
import type { CompanionView } from "@pipee/companion-contracts/companion-view";
import type { ConversationView } from "@pipee/companion-contracts/conversation-view";

const stateText: Record<ChromeStatusProjection["state"], string> = {
  ready: "Ready",
  "waiting-for-extension": "Waiting for extension",
  offline: "Offline",
  error: "Error",
};

export const projectChromeConversationView = (
  status: ChromeStatusProjection,
): ConversationView => ({
  contract: "pipee/conversation-view@1",
  label: "Chrome",
  tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
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
          { type: "text", text: "Browser connection", variant: "title" },
          {
            type: "badge",
            text: stateText[status.state],
            tone:
              status.state === "ready"
                ? "success"
                : status.state === "error"
                  ? "danger"
                  : "warning",
          },
        ],
      },
      {
        type: "group",
        direction: "row",
        gap: "medium",
        children: [
          { type: "field", label: "Bridge", value: status.bridge },
          { type: "field", label: "Connector", value: status.connector?.label ?? "Not connected" },
          {
            type: "field",
            label: "Profile",
            value: status.connector?.connected ? "Connected" : "Unavailable",
          },
        ],
      },
      ...(status.errorMessage
        ? ([
            { type: "text", text: status.errorMessage, variant: "caption", tone: "danger" },
          ] as const)
        : []),
    ],
  },
});

export const projectChromeCompanionView = (status: ChromeStatusProjection): CompanionView => ({
  contract: "pipee/companion-view@1",
  label: "Chrome",
  state: stateText[status.state],
  summary:
    status.errorMessage ??
    status.connector?.label ??
    (status.bridge === "running" ? "Bridge running" : "Bridge stopped"),
  tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
  glyph: "browser",
});
