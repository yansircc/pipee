import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

export class RuntimeLoopOwner {
  private fiber: Fiber.Fiber<void, unknown> | undefined;

  private constructor(
    private readonly runtime: Effect.Effect<void, unknown>,
    private readonly fork: (runtime: Effect.Effect<void, unknown>) => Fiber.Fiber<void, unknown>,
    private readonly transitionLock: Semaphore.Semaphore,
  ) {}

  static makeUnsafe(
    runtime: Effect.Effect<void, unknown>,
    fork: (runtime: Effect.Effect<void, unknown>) => Fiber.Fiber<void, unknown>,
  ): RuntimeLoopOwner {
    return new RuntimeLoopOwner(runtime, fork, Semaphore.makeUnsafe(1));
  }

  get start(): Effect.Effect<void> {
    return this.transitionLock.withPermits(1)(
      Effect.sync(() => {
        if (!this.fiber) this.fiber = this.fork(this.runtime);
      }),
    );
  }

  get restart(): Effect.Effect<void> {
    return this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (this.fiber) yield* Fiber.interrupt(this.fiber);
        this.fiber = this.fork(this.runtime);
      }),
    );
  }

  get stop(): Effect.Effect<void> {
    return this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const fiber = this.fiber;
        this.fiber = undefined;
        if (fiber) yield* Fiber.interrupt(fiber);
      }),
    );
  }
}
