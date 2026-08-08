import { Context, Data, Effect, Layer } from "effect"
import { ZeroYConnectionRegistryProvider } from "./zeroy-connection-registry-provider"

/**
 * Pipee zeroY connection directory HTTP service.
 *
 * A thin adapter over the shared zeroY connection registry: all pairing
 * orchestration (WordPress intent creation, code exchange, pairing-code
 * pairing, grant revocation) and persistence live in the registry handle so
 * the same state machine backs both this HTTP surface and the extension
 * capability port. WordPress owns site identity and grant hashes; Pipee
 * stores the grant secret in protected secret storage (credentialRef) and
 * non-sensitive metadata in the connection directory.
 *
 * Pairing flow (Pipee-initiated):
 *   beginPairing -> create intent on WordPress -> open browser URL
 *   callback (/zeroy/connect/callback) -> exchange code -> persist connection
 */

export class ZeroYConnectionsError extends Data.TaggedError("ZeroYConnectionsError")<{
  readonly operation: string
  readonly message: string
}> {}

export type ZeroYConnectionList = {
  readonly sites: ReadonlyArray<{
    readonly siteId: string
    readonly label: string
    readonly endpoint: string
    readonly grantId: string
    readonly createdAt: string
    readonly lastUsedAt: string | null
    readonly revoked: boolean
  }>
}

export type ZeroYPairingIntent = {
  readonly authorizationUrl: string
  readonly intentId: string
}

export class ZeroYConnections extends Context.Service<
  ZeroYConnections,
  {
    readonly list: Effect.Effect<ZeroYConnectionList, ZeroYConnectionsError>
    readonly beginPairing: (endpoint: string, label: string) => Effect.Effect<ZeroYPairingIntent, ZeroYConnectionsError>
    readonly exchangeCode: (
      intentId: string,
      code: string,
      state: string,
    ) => Effect.Effect<ZeroYConnectionList, ZeroYConnectionsError>
    readonly pairWithCode: (input: {
      readonly endpoint: string
      readonly intentId: string
      readonly code: string
      readonly state: string
      readonly redirectUri: string
      readonly label: string
    }) => Effect.Effect<ZeroYConnectionList, ZeroYConnectionsError>
    readonly revoke: (siteId: string) => Effect.Effect<void, ZeroYConnectionsError>
  }
>()("pipee/server/ZeroYConnections") {}

const mapError = (operation: string) => (cause: unknown) =>
  new ZeroYConnectionsError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  })

export const ZeroYConnectionsLive: Layer.Layer<
  ZeroYConnections,
  never,
  ZeroYConnectionRegistryProvider
> = Layer.effect(
  ZeroYConnections,
  Effect.gen(function* () {
    const registry = yield* ZeroYConnectionRegistryProvider

    const project = (): ZeroYConnectionList => ({
      sites: registry.rows().map((site) => ({
        siteId: site.siteId,
        label: site.label,
        endpoint: site.endpoint,
        grantId: site.grantId,
        createdAt: site.createdAt,
        lastUsedAt: site.lastUsedAt,
        revoked: site.revokedAt !== null,
      })),
    })

    return ZeroYConnections.of({
      list: Effect.sync(() => project()).pipe(Effect.mapError(mapError("list"))),
      beginPairing: (endpoint, label) =>
        registry.beginPairing(endpoint, label).pipe(Effect.mapError(mapError("begin-pairing"))),
      exchangeCode: (intentId, code, state) =>
        registry
          .exchangeCode(intentId, code, state)
          .pipe(
            Effect.map(() => project()),
            Effect.mapError(mapError("exchange-code")),
          ),
      pairWithCode: (input) =>
        registry
          .pairWithCode(input)
          .pipe(
            Effect.map(() => project()),
            Effect.mapError(mapError("pair-with-code")),
          ),
      revoke: (siteId) =>
        registry.revokeOnWordPress(siteId).pipe(Effect.mapError(mapError("revoke"))),
    })
  }),
)
