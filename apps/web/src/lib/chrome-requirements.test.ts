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

test("folds local and extension-owned Chrome requirements in capability order", () => {
  const facts = {
    packageLoaded: true,
    extensionReachable: true,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionDirectory: "/npm/pi-chrome/dist/browser-extension",
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
      status,
    }),
  ).toMatchObject({ requirement: "PackageLoaded", remediation: { type: "InstallPiPackage" } })
})
