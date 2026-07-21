import { Context, Data, Effect, Layer, Schema, SynchronizedRef } from "effect"
import { HttpClient } from "effect/unstable/http"
import { gt, valid } from "semver"
import { PipeeUpdateStatus } from "@/api/contract"

const PIPEE_REGISTRY_URL = "https://registry.npmjs.org/@yansircc%2Fpipee/latest"
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1_000
const FAILURE_TTL_MS = 15 * 60 * 1_000

const RegistryPackage = Schema.Struct({ version: Schema.String })

export class PipeeUpdateCheckError extends Data.TaggedError("PipeeUpdateCheckError")<{
  readonly message: string
}> {}

interface CachedStatus {
  readonly expiresAt: number
  readonly status: PipeeUpdateStatus
}

export interface PipeeUpdateSource {
  readonly latestVersion: Effect.Effect<string, PipeeUpdateCheckError>
}

export const projectPipeeUpdateStatus = (
  currentVersion: string,
  latestVersion: string,
  checkedAt: number,
): PipeeUpdateStatus => {
  if (valid(currentVersion) === null || valid(latestVersion) === null) {
    return PipeeUpdateStatus.make({ _tag: "Unavailable", checkedAt, currentVersion })
  }
  return gt(latestVersion, currentVersion)
    ? PipeeUpdateStatus.make({ _tag: "UpdateAvailable", checkedAt, currentVersion, latestVersion })
    : PipeeUpdateStatus.make({ _tag: "Current", checkedAt, currentVersion, latestVersion })
}

export const makePipeeUpdateChecker = (currentVersion: string, source: PipeeUpdateSource) =>
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make<CachedStatus | null>(null)
    const status = Effect.clockWith((clock) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe()
        return SynchronizedRef.modifyEffect(cache, (cached) => {
          if (cached !== null && cached.expiresAt > now) return Effect.succeed([cached.status, cached] as const)
          return source.latestVersion.pipe(
            Effect.map((latestVersion) => projectPipeeUpdateStatus(currentVersion, latestVersion, now)),
            Effect.orElseSucceed(() => PipeeUpdateStatus.make({ _tag: "Unavailable", checkedAt: now, currentVersion })),
            Effect.map((next) => {
              const ttl = next._tag === "Unavailable" ? FAILURE_TTL_MS : SUCCESS_TTL_MS
              const entry = { status: next, expiresAt: now + ttl }
              return [next, entry] as const
            }),
          )
        })
      }),
    )
    return PipeeUpdateChecker.of({ status })
  })

export class PipeeUpdateChecker extends Context.Service<
  PipeeUpdateChecker,
  {
    readonly status: Effect.Effect<PipeeUpdateStatus>
  }
>()("pipee/server/PipeeUpdateChecker") {}

const layerEffect = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient
  const latestVersion = http.get(new URL(PIPEE_REGISTRY_URL)).pipe(
    Effect.timeout("4 seconds"),
    Effect.flatMap((response) => {
      if (response.status < 200 || response.status >= 300) {
        return Effect.fail(new PipeeUpdateCheckError({ message: `npm registry returned HTTP ${response.status}` }))
      }
      return response.json.pipe(
        Effect.mapError(
          (cause) => new PipeeUpdateCheckError({ message: cause instanceof Error ? cause.message : String(cause) }),
        ),
      )
    }),
    Effect.flatMap(Schema.decodeUnknownEffect(RegistryPackage)),
    Effect.map((pkg) => pkg.version),
    Effect.mapError((cause) =>
      cause instanceof PipeeUpdateCheckError
        ? cause
        : new PipeeUpdateCheckError({ message: cause instanceof Error ? cause.message : String(cause) }),
    ),
  )
  return yield* makePipeeUpdateChecker(__APP_VERSION__, { latestVersion })
})

export const PipeeUpdateCheckerLive = Layer.effect(PipeeUpdateChecker, layerEffect)
