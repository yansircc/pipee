import type {
  ChromeStatusProjection,
  ChromeStatusRequirement as ChromeRequirement,
} from "@pi-suite/companion-contracts/chrome";
import type { BridgeStatusResponse } from "../protocol/schema.js";
import type { SessionAuthorizationSnapshot } from "./session-runtime-owner.js";

export type { ChromeRequirement, ChromeStatusProjection };

export type BridgeStatusSnapshot =
  | Readonly<{ _tag: "Available"; status: BridgeStatusResponse }>
  | Readonly<{ _tag: "Error"; message: string }>;

const authorizationProjection = (
  session: SessionAuthorizationSnapshot,
  now: number,
): ChromeStatusProjection["authorization"] => {
  if (session._tag !== "Active") return "locked";
  if (session.authorization.state === "indefinite") return "indefinite";
  return session.authorization.state === "timed" && session.authorization.deadline > now
    ? { expiresAt: session.authorization.deadline }
    : "locked";
};

export const projectChromeStatus = (
  session: SessionAuthorizationSnapshot,
  bridgeSnapshot: BridgeStatusSnapshot,
  now: number,
  extensionDirectory: string,
  sessionKey?: string,
): ChromeStatusProjection => {
  const authorization = authorizationProjection(session, now);
  if (bridgeSnapshot._tag === "Error") {
    const readiness =
      session._tag === "Poisoned" ? "error" : authorization === "locked" ? "locked" : "error";
    return {
      kind: "pi-chrome/status",
      version: 2,
      readiness,
      authorization,
      connection: "unknown",
      bridge: "error",
      requirements: [],
      errorMessage:
        session._tag === "Poisoned"
          ? "Chrome authorization ledger is fail-closed"
          : bridgeSnapshot.message,
    };
  }

  const { status } = bridgeSnapshot;
  const sessionRoute = sessionKey
    ? status.sessionRoutes.find((route) => route.sessionKey === sessionKey)
    : undefined;
  const connection: ChromeStatusProjection["connection"] = sessionRoute
    ? sessionRoute.availability === "expired"
      ? "unavailable"
      : sessionRoute.connected
        ? "connected"
        : "offline"
    : !status.binding
      ? "unpaired"
      : status.connector.connected
        ? "connected"
        : "offline";
  const selectedConnector = sessionRoute?.connector ?? status.binding;
  const shared: Omit<ChromeStatusProjection, "readiness" | "errorMessage"> = {
    kind: "pi-chrome/status" as const,
    version: 2 as const,
    authorization,
    connection,
    bridge: status.mode === "server" || status.mode === "client" ? "running" : "stopped",
    requirements: [
      status.protocolCompatibility.compatible
        ? { requirement: "ProtocolCompatible", satisfied: true }
        : {
            requirement: "ProtocolCompatible",
            satisfied: false,
            expectedVersion: status.protocolCompatibility.expectedExtensionDisplayVersion,
            actualVersion: status.protocolCompatibility.actualExtensionDisplayVersion,
            mismatches: ["ProtocolFingerprint"],
            remediation: {
              type: "ReloadUnpackedExtension",
              extensionId: status.protocolCompatibility.extensionId,
              directory: extensionDirectory,
            },
          },
      connection === "connected"
        ? { requirement: "ConnectorLive", satisfied: true }
        : {
            requirement: "ConnectorLive",
            satisfied: false,
            remediation: {
              type: "OpenChromeProfile",
              ...(selectedConnector
                ? {
                    connectorId: selectedConnector.connectorId,
                    connectorLabel: selectedConnector.label,
                  }
                : {}),
            },
          },
      authorization === "locked"
        ? {
            requirement: "Authorized",
            satisfied: false,
            remediation: { type: "AuthorizeSession" },
          }
        : { requirement: "Authorized", satisfied: true },
    ],
    ...(sessionRoute
      ? {
          connectorId: sessionRoute.connector.connectorId,
          connectorLabel: sessionRoute.connector.label,
          ...(sessionRoute.availability === "live"
            ? { connectorExpiresAt: sessionRoute.expiresAt }
            : {}),
        }
      : status.binding
        ? {
            connectorId: status.binding.connectorId,
            connectorLabel: status.binding.label,
          }
        : {}),
  };

  if (session._tag === "Poisoned") {
    return {
      ...shared,
      readiness: "error",
      errorMessage: "Chrome authorization ledger is fail-closed",
    };
  }
  if (authorization === "locked") return { ...shared, readiness: "locked" };
  if (shared.bridge === "stopped") {
    return {
      ...shared,
      readiness: "error",
      errorMessage: "Chrome bridge is stopped",
    };
  }
  return { ...shared, readiness: connection === "connected" ? "ready" : "offline" };
};
