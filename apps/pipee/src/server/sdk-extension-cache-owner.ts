import { Effect, Semaphore } from "effect"

export interface SdkExtensionCacheToken {
  readonly cwd: string
  readonly packageSetFingerprint: string
}

const sameToken = (left: SdkExtensionCacheToken | undefined, right: SdkExtensionCacheToken): boolean =>
  left?.cwd === right.cwd && left.packageSetFingerprint === right.packageSetFingerprint

/**
 * Mirrors the Pi SDK's single process-global extension cache. Service loading, cache invalidation,
 * and session construction must remain in this one critical section because each can read or mutate
 * that global cache.
 */
export class SdkExtensionCacheOwner {
  private applied: SdkExtensionCacheToken | undefined

  private constructor(private readonly gate: Semaphore.Semaphore) {}

  static make = Effect.map(Semaphore.make(1), (gate) => new SdkExtensionCacheOwner(gate))

  withCandidate<
    Services,
    A,
    CreateError,
    ReloadError,
    UseError,
    CreateRequirements,
    ReloadRequirements,
    UseRequirements,
  >(
    token: SdkExtensionCacheToken,
    createServices: Effect.Effect<Services, CreateError, CreateRequirements>,
    reloadServices: (services: Services) => Effect.Effect<void, ReloadError, ReloadRequirements>,
    useServices: (services: Services) => Effect.Effect<A, UseError, UseRequirements>,
  ): Effect.Effect<A, CreateError | ReloadError | UseError, CreateRequirements | ReloadRequirements | UseRequirements> {
    return this.gate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const services = yield* createServices
        if (!sameToken(this.applied, token)) {
          yield* reloadServices(services)
          this.applied = token
        }
        return yield* useServices(services)
      }),
    )
  }
}
