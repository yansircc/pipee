import type { ChromeStatusProjection, ChromeStatusRequirement } from "@/api/contract"
import type { ChromeCompatibility } from "@pi-suite/companion-contracts/chrome"
import { PI_COMPANION_PACKAGE_NAMES } from "./plugin-package-settings"

export type ChromeLocalRequirement =
  | Readonly<{
      requirement: "PackageLoaded"
      satisfied: boolean | null
      remediation: Readonly<{
        type: "InstallPiPackage"
        packageName: string
        command: string
      }>
    }>
  | Readonly<{
      requirement: "ExtensionReachable"
      satisfied: boolean | null
      remediation: Readonly<{
        type: "OpenExtensionsPage"
        url: string
        directory?: string
      }>
    }>

export type ChromeRequirement = ChromeLocalRequirement | ChromeStatusRequirement

export interface ChromeRequirementFacts {
  readonly packageLoaded: boolean | null
  readonly extensionReachable: boolean | null
  readonly extensionId: string | null
  readonly extensionDirectory: string | null
  readonly currentProfile: Readonly<{ connectorId: string; connectorLabel: string }> | null
  readonly compatibility: ChromeCompatibility
  readonly status: ChromeStatusProjection | undefined
}

export const chromeStatusTargetsAnotherProfile = (
  status: ChromeStatusProjection | undefined,
  currentProfile: ChromeRequirementFacts["currentProfile"],
): boolean =>
  status?.connectorId !== undefined && currentProfile !== null && status.connectorId !== currentProfile.connectorId

export const projectChromeRequirements = (facts: ChromeRequirementFacts): ReadonlyArray<ChromeRequirement> => {
  const remote = new Map(facts.status?.requirements.map((requirement) => [requirement.requirement, requirement]))
  const routeTargetsAnotherProfile = chromeStatusTargetsAnotherProfile(facts.status, facts.currentProfile)
  if (routeTargetsAnotherProfile) {
    remote.delete("ProtocolCompatible")
    remote.set("ConnectorLive", {
      requirement: "ConnectorLive",
      satisfied: false,
      remediation: {
        type: "OpenChromeProfile",
        connectorId: facts.currentProfile?.connectorId,
        connectorLabel: facts.currentProfile?.connectorLabel,
      },
    })
  }
  if (facts.currentProfile !== null && facts.compatibility._tag === "Verified") {
    remote.set("ProtocolCompatible", { requirement: "ProtocolCompatible", satisfied: true })
  } else if (facts.currentProfile !== null && facts.compatibility._tag === "Incompatible") {
    remote.set("ProtocolCompatible", {
      requirement: "ProtocolCompatible",
      satisfied: false,
      expectedVersion: facts.compatibility.expected.displayVersion,
      actualVersion: facts.compatibility.actual.displayVersion,
      mismatches: facts.compatibility.mismatches,
      remediation: {
        type: "ReloadUnpackedExtension",
        extensionId: facts.compatibility.expected.extensionId,
        directory: facts.extensionDirectory ?? "the installed pi-chrome browser-extension directory",
      },
    })
  }
  const remoteRequirementOrder = routeTargetsAnotherProfile
    ? (["ProtocolCompatible", "ConnectorLive", "Authorized"] as const)
    : facts.status?.authorization === "locked"
      ? (["ProtocolCompatible", "Authorized", "ConnectorLive"] as const)
      : (["ProtocolCompatible", "ConnectorLive", "Authorized"] as const)
  const extensionUrl = facts.extensionId ? `chrome://extensions/?id=${facts.extensionId}` : "chrome://extensions/"
  return [
    {
      requirement: "PackageLoaded",
      satisfied: facts.packageLoaded,
      remediation: {
        type: "InstallPiPackage",
        packageName: PI_COMPANION_PACKAGE_NAMES.chrome,
        command: `pi install npm:${PI_COMPANION_PACKAGE_NAMES.chrome}`,
      },
    },
    {
      requirement: "ExtensionReachable",
      satisfied: facts.extensionReachable,
      remediation: {
        type: "OpenExtensionsPage",
        url: extensionUrl,
        ...(facts.extensionDirectory === null ? {} : { directory: facts.extensionDirectory }),
      },
    },
    ...remoteRequirementOrder.flatMap((name) => {
      const requirement = remote.get(name)
      return requirement === undefined ? [] : [requirement]
    }),
  ]
}

export const firstUnsatisfiedChromeRequirement = (facts: ChromeRequirementFacts): ChromeRequirement | undefined =>
  projectChromeRequirements(facts).find((requirement) => requirement.satisfied === false)

export const chromeRequirementMessage = (requirement: ChromeRequirement): string => {
  switch (requirement.requirement) {
    case "PackageLoaded":
      return `Pi Chrome package is not loaded. Run: ${requirement.remediation.command}`
    case "ExtensionReachable":
      return `Chrome extension is not reachable in this profile. Open ${requirement.remediation.url}${
        requirement.remediation.directory ? ` and load ${requirement.remediation.directory}` : ""
      }`
    case "ProtocolCompatible":
      return requirement.satisfied
        ? "Chrome extension protocol is compatible"
        : `Chrome extension and Pi package are incompatible (${requirement.mismatches?.join(", ") ?? "version"}). Package ${requirement.expectedVersion}, Extension ${requirement.actualVersion}. Reload ${requirement.remediation.directory}`
    case "ConnectorLive":
      return requirement.satisfied
        ? "Chrome connector is live"
        : `Chrome connector is not live${requirement.remediation.connectorLabel ? ` for ${requirement.remediation.connectorLabel}` : ""}`
    case "Authorized":
      return requirement.satisfied
        ? "Chrome control is authorized"
        : "Chrome control is not authorized for this session"
  }
}
