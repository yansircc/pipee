import { expect, test } from "@effect/vitest"
import { ChromeStatusProjection } from "@/api/contract"
import { firstUnsatisfiedChromeRequirement, projectChromeRequirements } from "./chrome-requirements"

const status = ChromeStatusProjection.make({
  kind: "pi-chrome/status",
  version: 2,
  readiness: "offline",
  authorization: "indefinite",
  connection: "offline",
  bridge: "running",
  requirements: [
    {
      requirement: "ProtocolCompatible",
      satisfied: false,
      expectedVersion: "0.1.5",
      actualVersion: "0.16.0",
      remediation: {
        type: "ReloadUnpackedExtension",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        directory: "/npm/pi-chrome/dist/browser-extension",
      },
    },
    {
      requirement: "ConnectorLive",
      satisfied: false,
      remediation: { type: "OpenChromeProfile", connectorLabel: "Personal" },
    },
    { requirement: "Authorized", satisfied: true },
  ],
})

const verifiedCompatibility = (connectorId: string, connectorLabel: string) =>
  ({
    _tag: "Verified",
    evidence: {
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      displayVersion: "0.1.5",
      protocolFingerprint: "a".repeat(64),
      connectorIdentity: { connectorId, connectorLabel },
    },
  }) as const

test("folds local and extension-owned Chrome requirements in capability order", () => {
  const facts = {
    packageLoaded: true,
    extensionReachable: true,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionDirectory: "/npm/pi-chrome/dist/browser-extension",
    currentProfile: null,
    compatibility: { _tag: "Unknown" },
    status,
  } as const
  expect(projectChromeRequirements(facts).map((requirement) => requirement.requirement)).toEqual([
    "PackageLoaded",
    "ExtensionReachable",
    "ProtocolCompatible",
    "ConnectorLive",
    "Authorized",
  ])
  expect(firstUnsatisfiedChromeRequirement(facts)).toMatchObject({
    requirement: "ProtocolCompatible",
    expectedVersion: "0.1.5",
    actualVersion: "0.16.0",
  })
})

test("never lets a remote requirement outrank a missing local package", () => {
  expect(
    firstUnsatisfiedChromeRequirement({
      packageLoaded: false,
      extensionReachable: false,
      extensionId: null,
      extensionDirectory: null,
      currentProfile: null,
      compatibility: { _tag: "Unknown" },
      status,
    }),
  ).toMatchObject({ requirement: "PackageLoaded", remediation: { type: "InstallPiPackage" } })
})

test("keeps compatibility evidence bound to its connector identity", () => {
  const currentProfile = { connectorId: "connector-current", connectorLabel: "Current profile" }
  const facts = {
    packageLoaded: true,
    extensionReachable: true,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionDirectory: "/npm/pi-chrome/dist/browser-extension",
    currentProfile,
    compatibility: verifiedCompatibility(currentProfile.connectorId, currentProfile.connectorLabel),
    status: ChromeStatusProjection.make({ ...status, connectorId: "connector-route", connectorLabel: "Old route" }),
  } as const

  expect(firstUnsatisfiedChromeRequirement(facts)).toEqual({
    requirement: "ConnectorLive",
    satisfied: false,
    remediation: {
      type: "OpenChromeProfile",
      connectorId: currentProfile.connectorId,
      connectorLabel: currentProfile.connectorLabel,
    },
  })
  expect(projectChromeRequirements(facts)).not.toContainEqual(
    expect.objectContaining({ requirement: "ProtocolCompatible", satisfied: false }),
  )

  const reconnected = ChromeStatusProjection.make({
    ...facts.status,
    readiness: "ready",
    connection: "connected",
    connectorId: currentProfile.connectorId,
    connectorLabel: currentProfile.connectorLabel,
    requirements: [
      { requirement: "ProtocolCompatible", satisfied: true },
      { requirement: "ConnectorLive", satisfied: true },
      { requirement: "Authorized", satisfied: true },
    ],
  })
  expect(firstUnsatisfiedChromeRequirement({ ...facts, status: reconnected })).toBeUndefined()
})

test("shows authorization before route availability for an unpaired Web session", () => {
  const unpaired = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 2,
    readiness: "locked",
    authorization: "locked",
    connection: "unpaired",
    bridge: "running",
    requirements: [
      { requirement: "ConnectorLive", satisfied: false, remediation: { type: "OpenChromeProfile" } },
      { requirement: "Authorized", satisfied: false, remediation: { type: "AuthorizeSession" } },
    ],
  })
  expect(
    firstUnsatisfiedChromeRequirement({
      packageLoaded: true,
      extensionReachable: true,
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      extensionDirectory: "/npm/pi-chrome/dist/browser-extension",
      currentProfile: { connectorId: "connector-current", connectorLabel: "Current profile" },
      compatibility: verifiedCompatibility("connector-current", "Current profile"),
      status: unpaired,
    }),
  ).toMatchObject({ requirement: "Authorized", satisfied: false })
})
