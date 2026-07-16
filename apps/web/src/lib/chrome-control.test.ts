import { it } from "@effect/vitest"
import { Data, Effect, Exit } from "effect"
import { expect } from "vite-plus/test"
import { ChromeStatusProjection, type ChromeControlRequestType } from "@/api/contract"
import { BrowserPlatformLive, type ChromeExtensionRuntime } from "@/browser/browser-platform"
import {
  attachSameProfileChromeSession,
  ChromeControlError,
  completeSameProfileWebRun,
  ensureChromeSessionBinding,
  getPiChromeExtensionDirectory,
  getPiChromeExtensionExpectation,
  getPiChromeExtensionId,
  getPiChromeToolState,
  getSameProfileChromeStatus,
  hasLoadedPackage,
  hasLoadedPiChrome,
  isPiChromeControlEnabled,
  prepareSameProfileWebRun,
} from "./chrome-control"

const plugins = (
  packages: ReadonlyArray<{
    readonly packageName?: string
    readonly status: "loaded" | "installed" | "missing" | "disabled"
    readonly chromeExtensionId?: string
    readonly chromeExtensionDirectory?: string
    readonly chromeExtensionDisplayVersion?: string
    readonly chromeProtocolFingerprint?: string
  }>,
) => ({ packages })

const installChromeRuntime = (runtime: ChromeExtensionRuntime) => {
  return Effect.acquireRelease(
    Effect.sync(() =>
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: { runtime },
      }),
    ),
    () =>
      Effect.sync(() => {
        Reflect.deleteProperty(globalThis, "chrome")
      }),
  )
}

const expectation = {
  extensionId: "extension-id",
  displayVersion: "0.5.7",
  protocolFingerprint: "a".repeat(64),
} as const

const evidence = {
  ...expectation,
  connectorIdentity: { connectorId: "connector-work", connectorLabel: "Work profile" },
}

const externalResponse = (message: unknown) => {
  const type = typeof message === "object" && message !== null && "type" in message ? message.type : undefined
  return type === "pi-chrome/web-run/prepare"
    ? { version: 1, ok: true, type: "Prepared", evidence, pairingId: "pairing-id", offer: "opaque-offer" }
    : type === "pi-chrome/web-run/status"
      ? { version: 1, ok: true, type: "Status", evidence }
      : { version: 1, ok: true, type: "Completed", evidence }
}

it("detects only the loaded canonical pi-chrome package", () => {
  expect(hasLoadedPiChrome(plugins([{ packageName: "@yansircc/pi-chrome", status: "loaded" }]))).toBe(true)
  expect(hasLoadedPiChrome(plugins([{ packageName: "@yansircc/pi-chrome", status: "disabled" }]))).toBe(false)
  expect(hasLoadedPiChrome(plugins([{ packageName: "pi-chrome", status: "loaded" }]))).toBe(false)
  expect(hasLoadedPiChrome(plugins([{ packageName: "another-package", status: "loaded" }]))).toBe(false)
  expect(hasLoadedPackage(plugins([{ packageName: "@agegr/pi-weixin", status: "loaded" }]), "@agegr/pi-weixin")).toBe(
    true,
  )
  expect(hasLoadedPackage(plugins([{ packageName: "@agegr/pi-weixin", status: "disabled" }]), "@agegr/pi-weixin")).toBe(
    false,
  )
  expect(
    getPiChromeExtensionId(
      plugins([
        {
          packageName: "@yansircc/pi-chrome",
          status: "loaded",
          chromeExtensionId: "extension-id",
          chromeExtensionDirectory: "/npm/pi-chrome/dist/browser-extension",
          chromeExtensionDisplayVersion: "0.5.7",
          chromeProtocolFingerprint: "a".repeat(64),
        },
      ]),
    ),
  ).toBe("extension-id")
  expect(
    getPiChromeExtensionExpectation(
      plugins([
        {
          packageName: "@yansircc/pi-chrome",
          status: "loaded",
          chromeExtensionId: "extension-id",
          chromeExtensionDisplayVersion: "0.5.7",
          chromeProtocolFingerprint: "a".repeat(64),
        },
      ]),
    ),
  ).toEqual(expectation)
  expect(
    getPiChromeExtensionDirectory(
      plugins([
        {
          packageName: "@yansircc/pi-chrome",
          status: "loaded",
          chromeExtensionDirectory: "/npm/pi-chrome/dist/browser-extension",
        },
      ]),
    ),
  ).toBe("/npm/pi-chrome/dist/browser-extension")
  expect(getPiChromeExtensionId(plugins([{ packageName: "@yansircc/pi-chrome", status: "installed" }]))).toBeNull()
})

it.effect("classifies exact evidence and refuses drift before session attach", () =>
  Effect.gen(function* () {
    const mismatchedEvidence = { ...evidence, protocolFingerprint: "b".repeat(64) }
    yield* installChromeRuntime({
      sendMessage: (_extensionId, message, callback) => {
        const response = externalResponse(message)
        callback({ ...response, evidence: mismatchedEvidence })
      },
    })

    const status = yield* getSameProfileChromeStatus("extension-id", expectation)
    expect(status.compatibility).toMatchObject({
      _tag: "Incompatible",
      mismatches: ["ProtocolFingerprint"],
    })
    const commands: Array<ChromeControlRequestType> = []
    const failure = yield* attachSameProfileChromeSession("extension-id", expectation, (request) =>
      Effect.sync(() => commands.push(request)),
    ).pipe(Effect.flip)
    expect(failure).toBeInstanceOf(ChromeControlError)
    expect(commands).toEqual([])
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

it.effect("rejects excess response properties", () =>
  Effect.gen(function* () {
    yield* installChromeRuntime({
      sendMessage: (_extensionId, _message, callback) =>
        callback({ version: 1, ok: true, type: "Status", evidence, extra: true }),
    })

    expect(yield* getSameProfileChromeStatus("extension-id", expectation).pipe(Effect.flip)).toBeInstanceOf(
      ChromeControlError,
    )
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

it.effect("prepares, completes, and reads status through the profile extension", () =>
  Effect.gen(function* () {
    const messages: Array<{ readonly extensionId: string; readonly message: unknown }> = []
    yield* installChromeRuntime({
      sendMessage: (extensionId, message, callback) => {
        messages.push({ extensionId, message })
        callback(externalResponse(message))
      },
    })

    expect(yield* prepareSameProfileWebRun("extension-id", expectation)).toMatchObject({
      pairingId: "pairing-id",
      offer: "opaque-offer",
      evidence,
    })
    yield* completeSameProfileWebRun("extension-id", "pairing-id", expectation)
    expect(yield* getSameProfileChromeStatus("extension-id", expectation)).toEqual({
      connected: true,
      connectorId: "connector-work",
      connectorLabel: "Work profile",
      evidence,
      compatibility: { _tag: "Verified", evidence },
    })
    expect(messages).toHaveLength(3)
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

class AssertionFailure extends Data.TaggedError("AssertionFailure")<{
  readonly reason: string
}> {}

it.effect("establishes one session binding and compensates a failed assertion", () =>
  Effect.gen(function* () {
    yield* installChromeRuntime({
      sendMessage: (_extensionId, message, callback) => {
        callback(externalResponse(message))
      },
    })

    const successfulCommands: Array<ChromeControlRequestType> = []
    const result = yield* attachSameProfileChromeSession("extension-id", expectation, (request) =>
      Effect.sync(() => {
        successfulCommands.push(request)
        return { request }
      }),
    )
    expect(successfulCommands).toEqual([
      { action: { _tag: "WebAttach", offer: "opaque-offer" } },
      { action: { _tag: "WebAssert", pairingId: "pairing-id" } },
    ])
    expect(result).toEqual({ request: { action: { _tag: "WebAssert", pairingId: "pairing-id" } } })

    const failedCommands: Array<ChromeControlRequestType> = []
    const exit = yield* Effect.exit(
      attachSameProfileChromeSession("extension-id", expectation, (request) =>
        Effect.suspend(() => {
          failedCommands.push(request)
          return request.action._tag === "WebAssert"
            ? Effect.fail(new AssertionFailure({ reason: "assertion failed" }))
            : Effect.void
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failedCommands).toEqual([
      { action: { _tag: "WebAttach", offer: "opaque-offer" } },
      { action: { _tag: "WebAssert", pairingId: "pairing-id" } },
      { action: { _tag: "WebDetach", pairingId: "pairing-id" } },
    ])
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

it.effect("reuses only a live route for the current browser profile", () =>
  Effect.gen(function* () {
    const extensionMessages: Array<unknown> = []
    yield* installChromeRuntime({
      sendMessage: (_extensionId, message, callback) => {
        extensionMessages.push(message)
        callback(externalResponse(message))
      },
    })

    const commands: Array<ChromeControlRequestType> = []
    const invoke = (request: ChromeControlRequestType) =>
      Effect.sync(() => {
        commands.push(request)
        return { request }
      })
    const ready = ChromeStatusProjection.make({
      kind: "pi-chrome/status",
      version: 2,
      readiness: "ready",
      authorization: "indefinite",
      connection: "connected",
      bridge: "running",
      connectorId: "connector-work",
      connectorLabel: "Work profile",
      connectorExpiresAt: Number.MAX_SAFE_INTEGER,
      requirements: [],
    })

    expect(yield* ensureChromeSessionBinding("extension-id", expectation, ready, invoke)).toEqual({
      profile: expect.objectContaining({
        connected: true,
        connectorId: "connector-work",
        connectorLabel: "Work profile",
      }),
      commandResult: null,
    })
    expect(commands).toEqual([])

    const staleProfile = ChromeStatusProjection.make({ ...ready, connectorId: "connector-old" })
    expect(yield* ensureChromeSessionBinding("extension-id", expectation, staleProfile, invoke)).toEqual({
      profile: expect.objectContaining({
        connected: true,
        connectorId: "connector-work",
        connectorLabel: "Work profile",
      }),
      commandResult: { request: { action: { _tag: "WebAssert", pairingId: "pairing-id" } } },
    })
    const expiringLease = ChromeStatusProjection.make({ ...ready, connectorExpiresAt: 0 })
    expect(yield* ensureChromeSessionBinding("extension-id", expectation, expiringLease, invoke)).toEqual({
      profile: expect.objectContaining({
        connected: true,
        connectorId: "connector-work",
        connectorLabel: "Work profile",
      }),
      commandResult: { request: { action: { _tag: "WebAssert", pairingId: "pairing-id" } } },
    })
    expect(commands).toEqual([
      { action: { _tag: "WebAttach", offer: "opaque-offer" } },
      { action: { _tag: "WebAssert", pairingId: "pairing-id" } },
      { action: { _tag: "WebAttach", offer: "opaque-offer" } },
      { action: { _tag: "WebAssert", pairingId: "pairing-id" } },
    ])
    expect(extensionMessages).toHaveLength(7)
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

it.effect("fails closed when browser authorization is near expiry", () =>
  Effect.gen(function* () {
    yield* installChromeRuntime({
      sendMessage: (_extensionId, message, callback) => {
        callback(externalResponse(message))
      },
    })
    const status = ChromeStatusProjection.make({
      kind: "pi-chrome/status",
      version: 2,
      readiness: "ready",
      authorization: { expiresAt: 0 },
      connection: "connected",
      bridge: "running",
      connectorId: "connector-work",
      connectorExpiresAt: Number.MAX_SAFE_INTEGER,
      requirements: [],
    })
    const exit = yield* Effect.exit(ensureChromeSessionBinding("extension-id", expectation, status, () => Effect.void))
    expect(Exit.isFailure(exit)).toBe(true)
  }).pipe(Effect.provide(BrowserPlatformLive)),
)

it("derives browser control from authorization and the active chrome tool family", () => {
  expect(getPiChromeToolState([{ name: "read", description: "", active: true }])).toBeNull()
  expect(
    getPiChromeToolState([
      { name: "chrome_tab", description: "", active: false },
      { name: "chrome_snapshot", description: "", active: false },
    ]),
  ).toBe(false)
  expect(
    getPiChromeToolState([
      { name: "chrome_tab", description: "", active: true },
      { name: "chrome_snapshot", description: "", active: false },
    ]),
  ).toBe(true)
  expect(isPiChromeControlEnabled(false, true)).toBe(false)
  expect(isPiChromeControlEnabled(true, false)).toBe(false)
  expect(isPiChromeControlEnabled(true, true)).toBe(true)
  expect(isPiChromeControlEnabled(null, null)).toBe(false)
  expect(isPiChromeControlEnabled(null, true)).toBe(false)
  expect(isPiChromeControlEnabled(true, null)).toBe(true)
})
