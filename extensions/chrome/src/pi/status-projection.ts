import {
  classifyChromeConnectorCompatibility,
  type ChromeStatusProjection,
} from "../protocol/chrome.js";
import type { BridgeStatusResponse } from "../protocol/schema.js";

export type { ChromeStatusProjection };

export type BridgeStatusSnapshot =
  | Readonly<{ _tag: "Available"; status: BridgeStatusResponse }>
  | Readonly<{ _tag: "Error"; message: string }>;

export const projectChromeStatus = (
  bridgeSnapshot: BridgeStatusSnapshot,
  extensionDirectory: string,
): ChromeStatusProjection => {
  if (bridgeSnapshot._tag === "Error") {
    return {
      kind: "pi-chrome/status",
      version: 3,
      state: "error",
      bridge: "error",
      extensionDirectory,
      errorMessage: bridgeSnapshot.message,
    };
  }

  const { status } = bridgeSnapshot;
  const bridge = status.mode === "server" || status.mode === "client" ? "running" : "stopped";
  if (bridge === "stopped") {
    return {
      kind: "pi-chrome/status",
      version: 3,
      state: "error",
      bridge,
      extensionDirectory,
      errorMessage: "Chrome bridge is stopped",
    };
  }
  if (!status.connector) {
    return {
      kind: "pi-chrome/status",
      version: 3,
      state: "waiting-for-extension",
      bridge,
      extensionDirectory,
    };
  }

  const compatibility = classifyChromeConnectorCompatibility(
    status.extensionExpectation,
    status.connector,
  );
  const projectedConnector = {
    id: status.connector.connectorId,
    label: status.connector.label,
    connected: status.connector.connected,
    ...(status.connector.lastSeenAt === undefined
      ? {}
      : { lastSeenAt: status.connector.lastSeenAt }),
  };
  if (compatibility._tag === "Incompatible") {
    return {
      kind: "pi-chrome/status",
      version: 3,
      state: "error",
      bridge,
      connector: projectedConnector,
      extensionDirectory,
      errorMessage: `Chrome extension is incompatible: ${compatibility.mismatches.join(", ")}`,
    };
  }
  return {
    kind: "pi-chrome/status",
    version: 3,
    state: status.connector.connected ? "ready" : "offline",
    bridge,
    connector: projectedConnector,
    extensionDirectory,
  };
};
