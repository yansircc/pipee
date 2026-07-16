import { Clock, Data, Duration, Effect, Schema } from "effect"
import { BrowserPlatform } from "@/browser/browser-platform"
import type { ChromeControlRequestType, ChromeStatusProjection } from "@/api/contract"
import {
  ChromeExternalResponse,
  classifyChromeCompatibility,
  type ChromeCompatibility,
  type ChromeExtensionEvidence,
  type ChromeExtensionExpectation,
  type ChromeExternalResponse as ChromeExternalResponseType,
} from "@pi-suite/companion-contracts/chrome"
import { PI_COMPANION_PACKAGE_NAMES } from "./plugin-package-settings"
import type { ToolEntry } from "./tool-presets"

interface PluginsProjection {
  readonly packages: ReadonlyArray<{
    readonly packageName?: string
    readonly status: "loaded" | "installed" | "missing" | "disabled"
    readonly chromeExtensionId?: string
    readonly chromeExtensionDirectory?: string
    readonly chromeExtensionDisplayVersion?: string
    readonly chromeProtocolFingerprint?: string
  }>
}

export function hasLoadedPackage(plugins: PluginsProjection, packageName: string): boolean {
  return plugins.packages.some((pkg) => pkg.packageName === packageName && pkg.status === "loaded")
}

export function hasLoadedPiChrome(plugins: PluginsProjection): boolean {
  return hasLoadedPackage(plugins, PI_COMPANION_PACKAGE_NAMES.chrome)
}

export function getPiChromeExtensionId(plugins: PluginsProjection): string | null {
  return (
    plugins.packages.find((pkg) => pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome && pkg.status === "loaded")
      ?.chromeExtensionId ?? null
  )
}

export function getPiChromeExtensionDirectory(plugins: PluginsProjection): string | null {
  return (
    plugins.packages.find((pkg) => pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome && pkg.status === "loaded")
      ?.chromeExtensionDirectory ?? null
  )
}

export function getPiChromeExtensionExpectation(plugins: PluginsProjection): ChromeExtensionExpectation | null {
  const found = plugins.packages.find(
    (pkg) => pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome && pkg.status === "loaded",
  )
  return found?.chromeExtensionId === undefined ||
    found.chromeExtensionDisplayVersion === undefined ||
    found.chromeProtocolFingerprint === undefined
    ? null
    : {
        extensionId: found.chromeExtensionId,
        displayVersion: found.chromeExtensionDisplayVersion,
        protocolFingerprint: found.chromeProtocolFingerprint,
      }
}

export function getPiChromeToolState(tools: ReadonlyArray<ToolEntry>): boolean | null {
  const chromeTools = tools.filter((tool) => tool.name.startsWith("chrome_"))
  if (chromeTools.length === 0) return null
  return chromeTools.some((tool) => tool.active)
}

export function isPiChromeControlEnabled(authorized: boolean | null, toolsActive: boolean | null): boolean {
  return authorized === true && toolsActive !== false
}

export class ChromeControlError extends Data.TaggedError("ChromeControlError")<{
  readonly operation: string
  readonly message: string
}> {}

export type SameProfileChromeStatus = Readonly<{
  connected: true
  connectorId: string
  connectorLabel: string
  evidence: ChromeExtensionEvidence
  compatibility: ChromeCompatibility
}>

export type SameProfileChromeConnection = SameProfileChromeStatus | Readonly<{ connected: false }>

export type ChromeSessionBinding<T> = Readonly<{
  profile: SameProfileChromeStatus
  commandResult: T | null
}>

const minimumRouteLease = Duration.toMillis(Duration.minutes(1))

const invalidResponse = (operation: string, fallback: string, response: unknown) => {
  const decoded = Schema.decodeUnknownOption(ChromeExternalResponse, { onExcessProperty: "error" })(response)
  return new ChromeControlError({
    operation,
    message: decoded._tag === "Some" && !decoded.value.ok ? decoded.value.error.message : fallback,
  })
}

const request = (extensionId: string, message: unknown) =>
  BrowserPlatform.pipe(
    Effect.flatMap((browser) => browser.sendChromeExtensionMessage(extensionId, message)),
    Effect.mapError(
      (error) =>
        new ChromeControlError({
          operation: error.operation,
          message: error.message,
        }),
    ),
  )

const decodeResponse = (operation: string, response: unknown) =>
  Schema.decodeUnknownEffect(ChromeExternalResponse, { onExcessProperty: "error" })(response).pipe(
    Effect.mapError(() => invalidResponse(operation, "The Pi Chrome Connector returned an invalid response", response)),
    Effect.flatMap((decoded) =>
      decoded.ok
        ? Effect.succeed(decoded)
        : Effect.fail(new ChromeControlError({ operation, message: decoded.error.message })),
    ),
  )

type ChromeExternalSuccessResponse = Extract<ChromeExternalResponseType, { readonly ok: true }>

const expectResponse = <Type extends ChromeExternalSuccessResponse["type"]>(
  operation: string,
  type: Type,
  response: unknown,
) =>
  decodeResponse(operation, response).pipe(
    Effect.flatMap((decoded) =>
      decoded.type === type
        ? Effect.succeed(decoded as Extract<ChromeExternalSuccessResponse, { readonly type: Type }>)
        : Effect.fail(new ChromeControlError({ operation, message: `Expected Chrome ${type} response` })),
    ),
  )

const requireVerified = (operation: string, expected: ChromeExtensionExpectation, actual: ChromeExtensionEvidence) => {
  const compatibility = classifyChromeCompatibility(expected, actual)
  return compatibility._tag === "Verified"
    ? Effect.succeed(compatibility)
    : Effect.fail(
        new ChromeControlError({
          operation,
          message: `Chrome extension evidence is incompatible: ${compatibility._tag === "Incompatible" ? compatibility.mismatches.join(", ") : "unknown"}`,
        }),
      )
}

export const getSameProfileChromeStatus = (extensionId: string, expected: ChromeExtensionExpectation | null) =>
  request(extensionId, {
    version: 1,
    type: "pi-chrome/web-run/status",
  }).pipe(
    Effect.flatMap((response) => expectResponse("status", "Status", response)),
    Effect.map(
      (response): SameProfileChromeStatus => ({
        connected: true,
        connectorId: response.evidence.connectorIdentity.connectorId,
        connectorLabel: response.evidence.connectorIdentity.connectorLabel,
        evidence: response.evidence,
        compatibility: classifyChromeCompatibility(expected, response.evidence),
      }),
    ),
  )

export const prepareSameProfileWebRun = (extensionId: string, expected: ChromeExtensionExpectation) =>
  request(extensionId, { version: 1, type: "pi-chrome/web-run/prepare" }).pipe(
    Effect.flatMap((response) => expectResponse("prepare", "Prepared", response)),
    Effect.tap((response) => requireVerified("prepare.compatibility", expected, response.evidence)),
  )

export const completeSameProfileWebRun = (
  extensionId: string,
  pairingId: string,
  expected: ChromeExtensionExpectation,
  preparedEvidence?: ChromeExtensionEvidence,
) =>
  request(extensionId, {
    version: 1,
    type: "pi-chrome/web-run/complete",
    pairingId,
  }).pipe(
    Effect.flatMap((response) => expectResponse("complete", "Completed", response)),
    Effect.tap((response) => requireVerified("complete.compatibility", expected, response.evidence)),
    Effect.tap((response) =>
      preparedEvidence === undefined ||
      (preparedEvidence.connectorIdentity.connectorId === response.evidence.connectorIdentity.connectorId &&
        preparedEvidence.extensionId === response.evidence.extensionId)
        ? Effect.void
        : Effect.fail(
            new ChromeControlError({
              operation: "complete.connector",
              message: "Chrome completion came from a different connector",
            }),
          ),
    ),
    Effect.asVoid,
  )

export const attachSameProfileChromeSession = <T, E, R>(
  extensionId: string,
  expected: ChromeExtensionExpectation,
  invokeChromeControl: (request: ChromeControlRequestType) => Effect.Effect<T, E, R>,
): Effect.Effect<T, ChromeControlError | E, BrowserPlatform | R> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSameProfileWebRun(extensionId, expected)
    yield* invokeChromeControl({ action: { _tag: "WebAttach", offer: prepared.offer } })
    return yield* completeSameProfileWebRun(extensionId, prepared.pairingId, expected, prepared.evidence).pipe(
      Effect.andThen(invokeChromeControl({ action: { _tag: "WebAssert", pairingId: prepared.pairingId } })),
      Effect.onError(() =>
        invokeChromeControl({ action: { _tag: "WebDetach", pairingId: prepared.pairingId } }).pipe(Effect.ignore),
      ),
    )
  })

export const ensureChromeSessionBinding = <T, E, R>(
  extensionId: string,
  expected: ChromeExtensionExpectation,
  sessionStatus: ChromeStatusProjection | undefined,
  invokeChromeControl: (request: ChromeControlRequestType) => Effect.Effect<T, E, R>,
): Effect.Effect<ChromeSessionBinding<T>, ChromeControlError | E, BrowserPlatform | R> =>
  Effect.gen(function* () {
    const profile = yield* getSameProfileChromeStatus(extensionId, expected)
    yield* requireVerified("binding.compatibility", expected, profile.evidence)
    const now = yield* Clock.currentTimeMillis
    const authorization = sessionStatus?.authorization
    if (authorization === "locked") {
      return yield* new ChromeControlError({
        operation: "binding.authorization",
        message: "Browser control is locked for this session",
      })
    }
    if (typeof authorization === "object" && authorization.expiresAt <= now + minimumRouteLease) {
      return yield* new ChromeControlError({
        operation: "binding.authorization",
        message: "Browser control authorization is too close to expiry; re-enable browser control before sending",
      })
    }
    const routeReady =
      sessionStatus?.readiness === "ready" &&
      sessionStatus.connection === "connected" &&
      sessionStatus.bridge === "running" &&
      sessionStatus.connectorId === profile.connectorId &&
      sessionStatus.connectorExpiresAt !== undefined &&
      sessionStatus.connectorExpiresAt > now + minimumRouteLease
    if (routeReady) return { profile, commandResult: null }

    const commandResult = yield* attachSameProfileChromeSession(extensionId, expected, invokeChromeControl)
    return { profile, commandResult }
  })
