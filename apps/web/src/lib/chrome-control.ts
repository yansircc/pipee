import { Clock, Data, Duration, Effect, Schema } from "effect"
import { BrowserPlatform } from "@/browser/browser-platform"
import type { ChromeControlRequestType, ChromeStatusProjection } from "@/api/contract"
import { PI_COMPANION_PACKAGE_NAMES } from "./plugin-package-settings"
import type { ToolEntry } from "./tool-presets"

interface PluginsProjection {
  readonly packages: ReadonlyArray<{
    readonly packageName?: string
    readonly status: "loaded" | "installed" | "missing" | "disabled"
    readonly chromeExtensionId?: string
    readonly chromeExtensionDirectory?: string
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

export function getPiChromeToolState(tools: ReadonlyArray<ToolEntry>): boolean | null {
  const chromeTools = tools.filter((tool) => tool.name.startsWith("chrome_"))
  if (chromeTools.length === 0) return null
  return chromeTools.some((tool) => tool.active)
}

export function isPiChromeControlEnabled(authorized: boolean | null, toolsActive: boolean | null): boolean {
  return authorized === true && toolsActive !== false
}

const PreparedWebRun = Schema.Struct({
  pairingId: Schema.NonEmptyString,
  offer: Schema.NonEmptyString,
})
type PreparedWebRun = typeof PreparedWebRun.Type

const PreparedResponse = Schema.Struct({
  ok: Schema.Literal(true),
  pairingId: Schema.NonEmptyString,
  offer: Schema.NonEmptyString,
})

const CompletedResponse = Schema.Struct({ ok: Schema.Literal(true) })

const StatusResponse = Schema.Struct({
  ok: Schema.Literal(true),
  connectorId: Schema.NonEmptyString,
  connectorLabel: Schema.NonEmptyString,
})

const ErrorResponse = Schema.Struct({ error: Schema.String })

export class ChromeControlError extends Data.TaggedError("ChromeControlError")<{
  readonly operation: string
  readonly message: string
}> {}

export type SameProfileChromeStatus = Readonly<{
  connected: true
  connectorId: string
  connectorLabel: string
}>

export type SameProfileChromeConnection = SameProfileChromeStatus | Readonly<{ connected: false }>

export type ChromeSessionBinding<T> = Readonly<{
  profile: SameProfileChromeStatus
  commandResult: T | null
}>

const minimumRouteLease = Duration.toMillis(Duration.minutes(1))

const invalidResponse = (operation: string, fallback: string, response: unknown) => {
  const decoded = Schema.decodeUnknownOption(ErrorResponse)(response)
  return new ChromeControlError({
    operation,
    message: decoded._tag === "Some" ? decoded.value.error : fallback,
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

export const getSameProfileChromeStatus = (extensionId: string) =>
  request(extensionId, {
    type: "pi-chrome/web-run/status",
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(StatusResponse)(response).pipe(
        Effect.mapError(() =>
          invalidResponse("status", "The Pi Chrome Connector returned an invalid profile status", response),
        ),
      ),
    ),
    Effect.map(
      (response): SameProfileChromeStatus => ({
        connected: true,
        connectorId: response.connectorId,
        connectorLabel: response.connectorLabel,
      }),
    ),
  )

export const prepareSameProfileWebRun = (
  extensionId: string,
): Effect.Effect<PreparedWebRun, ChromeControlError, BrowserPlatform> =>
  request(extensionId, { type: "pi-chrome/web-run/prepare" }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(PreparedResponse)(response).pipe(
        Effect.mapError(() =>
          invalidResponse("prepare", "The Pi Chrome Connector returned an invalid web run offer", response),
        ),
      ),
    ),
    Effect.map(({ pairingId, offer }) => PreparedWebRun.make({ pairingId, offer })),
  )

export const completeSameProfileWebRun = (extensionId: string, pairingId: string) =>
  request(extensionId, {
    type: "pi-chrome/web-run/complete",
    pairingId,
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(CompletedResponse)(response).pipe(
        Effect.mapError(() =>
          invalidResponse("complete", "The Pi Chrome Connector could not confirm this web run", response),
        ),
      ),
    ),
    Effect.asVoid,
  )

export const attachSameProfileChromeSession = <T, E, R>(
  extensionId: string,
  invokeChromeControl: (request: ChromeControlRequestType) => Effect.Effect<T, E, R>,
): Effect.Effect<T, ChromeControlError | E, BrowserPlatform | R> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSameProfileWebRun(extensionId)
    yield* invokeChromeControl({ action: { _tag: "WebAttach", offer: prepared.offer } })
    return yield* completeSameProfileWebRun(extensionId, prepared.pairingId).pipe(
      Effect.andThen(invokeChromeControl({ action: { _tag: "WebAssert", pairingId: prepared.pairingId } })),
      Effect.onError(() =>
        invokeChromeControl({ action: { _tag: "WebDetach", pairingId: prepared.pairingId } }).pipe(Effect.ignore),
      ),
    )
  })

export const ensureChromeSessionBinding = <T, E, R>(
  extensionId: string,
  sessionStatus: ChromeStatusProjection | undefined,
  invokeChromeControl: (request: ChromeControlRequestType) => Effect.Effect<T, E, R>,
): Effect.Effect<ChromeSessionBinding<T>, ChromeControlError | E, BrowserPlatform | R> =>
  Effect.gen(function* () {
    const profile = yield* getSameProfileChromeStatus(extensionId)
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

    const commandResult = yield* attachSameProfileChromeSession(extensionId, invokeChromeControl)
    return { profile, commandResult }
  })
