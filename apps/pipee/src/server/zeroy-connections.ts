import { Context, Data, Effect, FileSystem, Layer, Path, SynchronizedRef } from "effect"
import type { NodeServices } from "@effect/platform-node/NodeServices"
import { ZeroYConnectionRegistryProvider } from "./zeroy-connection-registry-provider"

/**
 * Pipee-side zeroY connection directory service.
 *
 * Owns the persistent connection library and drives browser pairing. The
 * WordPress plugin owns site identity and grant hashes; Pipee stores the
 * grant secret in protected secret storage (credentialRef) and non-sensitive
 * metadata in the connection directory.
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

/** Pending pairing state held by Pipee until the callback returns. */
export type PendingPairing = {
  readonly intentId: string
  readonly endpoint: string
  readonly label: string
  readonly state: string
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly expiresAt: number
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

/** Protected zeroY connection directory under the user home. */
const connectionDirectory = (home: string): string => `${home}/.pipee/zeroy`

export const ZeroYConnectionsLive: Layer.Layer<
  ZeroYConnections,
  never,
  NodeServices | ZeroYConnectionRegistryProvider
> = Layer.effect(
  ZeroYConnections,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
    const directory = connectionDirectory(home)
    const registry = yield* ZeroYConnectionRegistryProvider
    const pending = yield* SynchronizedRef.make(new Map<string, PendingPairing>())

    const persist = registry.persist(directory)

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

    const persistEffect = persist.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    )

    return ZeroYConnections.of({
      list: persistEffect.pipe(Effect.as(project())).pipe(Effect.mapError(mapError("list"))),
      beginPairing: (endpoint, label) =>
        Effect.gen(function* () {
          const target = endpoint.trim().replace(/\/+$/, "")
          if (!URL.canParse(target) || !/^https?:\/\//.test(target)) {
            return yield* new ZeroYConnectionsError({
              operation: "begin-pairing",
              message: `Invalid zeroY endpoint: ${endpoint}`,
            })
          }
          const state = crypto.randomUUID()
          const codeVerifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
          const codeChallenge = codeVerifier
          const redirectUri = "http://127.0.0.1:30141/zeroy/connect/callback"
          const intentId = crypto.randomUUID()
          const pendingPairing: PendingPairing = {
            intentId,
            endpoint: target,
            label,
            state,
            codeVerifier,
            redirectUri,
            expiresAt: Date.now() + 10 * 60 * 1000,
          }
          yield* SynchronizedRef.update(pending, (map) => new Map(map).set(intentId, pendingPairing))

          const authorizeUrl = new URL(`${target}/wp-json/zeroy/v1/connection/authorize`)
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(authorizeUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  intent_id: intentId,
                  client_id: "pipee-local",
                  redirect_uri: redirectUri,
                  code_challenge: codeChallenge,
                  state,
                  label,
                }),
              }),
            catch: (cause) =>
              new ZeroYConnectionsError({
                operation: "begin-pairing",
                message: `Could not reach ${target}: ${String(cause)}`,
              }),
          })
          if (!response.ok) {
            return yield* new ZeroYConnectionsError({
              operation: "begin-pairing",
              message: `WordPress rejected the authorization intent (${response.status}).`,
            })
          }
          const created = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new ZeroYConnectionsError({
                operation: "begin-pairing",
                message: "Invalid authorize response",
              }),
          })
          if (typeof created.intentId !== "string" || created.intentId === "") {
            return yield* new ZeroYConnectionsError({
              operation: "begin-pairing",
              message: "WordPress did not return an authorization intent.",
            })
          }
          const authorizationUrl =
            `${target}/wp-admin/admin.php?page=zeroy-connect` +
            `&intent_id=${encodeURIComponent(created.intentId)}` +
            `&client_id=${encodeURIComponent("pipee-local")}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&code_challenge=${encodeURIComponent(codeChallenge)}` +
            `&state=${encodeURIComponent(state)}`
          return { authorizationUrl, intentId: created.intentId }
        }).pipe(Effect.mapError(mapError("begin-pairing"))),
      exchangeCode: (intentId, code, state) =>
        Effect.gen(function* () {
          const current = yield* SynchronizedRef.get(pending)
          const pairing = current.get(intentId)
          if (pairing === undefined) {
            return yield* new ZeroYConnectionsError({
              operation: "exchange-code",
              message: "Pairing intent is missing or already consumed.",
            })
          }
          if (pairing.expiresAt < Date.now()) {
            return yield* new ZeroYConnectionsError({
              operation: "exchange-code",
              message: "Pairing intent has expired.",
            })
          }
          if (pairing.state !== state) {
            return yield* new ZeroYConnectionsError({
              operation: "exchange-code",
              message: "Pairing state does not match.",
            })
          }
          const exchangeUrl = new URL(`${pairing.endpoint}/wp-json/zeroy/v1/connection/exchange`)
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(exchangeUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  intent_id: intentId,
                  code,
                  code_verifier: pairing.codeVerifier,
                  state,
                  redirect_uri: pairing.redirectUri,
                }),
              }),
            catch: (cause) =>
              new ZeroYConnectionsError({
                operation: "exchange-code",
                message: `Exchange request failed: ${String(cause)}`,
              }),
          })
          if (!response.ok) {
            return yield* new ZeroYConnectionsError({
              operation: "exchange-code",
              message: `WordPress rejected the code exchange (${response.status}).`,
            })
          }
          const grant = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new ZeroYConnectionsError({
                operation: "exchange-code",
                message: "Invalid exchange response",
              }),
          })
          if (
            typeof grant.grantId !== "string" ||
            typeof grant.siteId !== "string" ||
            typeof grant.label !== "string"
          ) {
            return yield* new ZeroYConnectionsError({
              operation: "exchange-code",
              message: "WordPress returned an invalid grant.",
            })
          }
          registry.upsert(
            {
              siteId: grant.siteId,
              label: pairing.label,
              endpoint: pairing.endpoint,
              grantId: grant.grantId,
            },
            code,
          )
          yield* SynchronizedRef.update(pending, (map) => {
            const next = new Map(map)
            next.delete(intentId)
            return next
          })
          yield* persistEffect
          return project()
        }).pipe(Effect.mapError(mapError("exchange-code"))),
      pairWithCode: (input) =>
        Effect.gen(function* () {
          const target = input.endpoint.trim().replace(/\/+$/, "")
          if (!URL.canParse(target) || !/^https?:\/\//.test(target)) {
            return yield* new ZeroYConnectionsError({
              operation: "pair-with-code",
              message: `Invalid zeroY endpoint: ${input.endpoint}`,
            })
          }
          const exchangeUrl = new URL(`${target}/wp-json/zeroy/v1/connection/exchange`)
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(exchangeUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  intent_id: input.intentId,
                  code: input.code,
                  code_verifier: input.code,
                  state: input.state,
                  redirect_uri: input.redirectUri,
                }),
              }),
            catch: (cause) =>
              new ZeroYConnectionsError({
                operation: "pair-with-code",
                message: `Exchange request failed: ${String(cause)}`,
              }),
          })
          if (!response.ok) {
            return yield* new ZeroYConnectionsError({
              operation: "pair-with-code",
              message: `WordPress rejected the pairing code (${response.status}).`,
            })
          }
          const grant = yield* Effect.tryPromise({
            try: () => response.json() as Promise<Record<string, unknown>>,
            catch: () =>
              new ZeroYConnectionsError({
                operation: "pair-with-code",
                message: "Invalid exchange response",
              }),
          })
          if (typeof grant.grantId !== "string" || typeof grant.siteId !== "string") {
            return yield* new ZeroYConnectionsError({
              operation: "pair-with-code",
              message: "WordPress returned an invalid grant.",
            })
          }
          registry.upsert(
            {
              siteId: grant.siteId,
              label: input.label || input.endpoint,
              endpoint: target,
              grantId: grant.grantId,
            },
            input.code,
          )
          yield* persistEffect
          return project()
        }).pipe(Effect.mapError(mapError("pair-with-code"))),
      revoke: (siteId) =>
        Effect.gen(function* () {
          registry.provider.forExtension("zeroy").revoke(siteId)
          yield* persistEffect
        }).pipe(Effect.mapError(mapError("revoke"))),
    })
  }),
)
