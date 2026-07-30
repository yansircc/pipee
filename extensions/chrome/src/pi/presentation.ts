import type { PresentationDocument } from "@pipee/companion-contracts/presentation";
import type { ChromeStatusProjection } from "./status-projection.js";

const stateText: Record<ChromeStatusProjection["state"], string> = {
  ready: "Ready",
  "waiting-for-extension": "Waiting for extension",
  offline: "Offline",
  error: "Error",
};

const artifactTitle = (status: ChromeStatusProjection): string => {
  if (status.errorMessage) return "Browser connection failed";
  if (status.state === "ready") return "Browser connected";
  if (status.state === "waiting-for-extension") return "Browser extension needed";
  if (status.state === "offline") return "Browser is offline";
  return "Browser needs attention";
};

const statusSummary = (status: ChromeStatusProjection): string =>
  `Chrome · ${status.connector?.label ?? (status.bridge === "running" ? "Bridge running" : "Bridge stopped")}`;

export const projectChromeArtifact = (status: ChromeStatusProjection): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title: artifactTitle(status),
  summary: statusSummary(status),
  tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
  icon: "browser",
  status: {
    text: stateText[status.state],
    tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
  },
  body: {
    type: "group",
    direction: "column",
    gap: "medium",
    children: [
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

export const projectChromeLivePresentation = (
  status: ChromeStatusProjection,
): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title: "Chrome",
  summary:
    status.errorMessage ??
    status.connector?.label ??
    (status.bridge === "running" ? "Bridge running" : "Bridge stopped"),
  tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
  icon: "browser",
  status: {
    text: stateText[status.state],
    tone: status.state === "ready" ? "success" : status.state === "error" ? "danger" : "warning",
  },
});
