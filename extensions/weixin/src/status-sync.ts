import { Effect, Exit, Option, Ref, Scope, Semaphore } from "effect";

export interface StatusSync {
  readonly replace: <R>(subscriber: Effect.Effect<void, never, R>) => Effect.Effect<void, never, R>;
  readonly close: Effect.Effect<void>;
}

export const makeStatusSync = (): StatusSync => {
  const current = Ref.makeUnsafe(Option.none<Scope.Closeable>());
  const lifecycle = Semaphore.makeUnsafe(1);
  const closeRaw = Ref.getAndSet(current, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (scope) => Scope.close(scope, Exit.succeed(undefined)),
      }),
    ),
  );

  return {
    replace: (subscriber) =>
      lifecycle.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* closeRaw;
            const scope = yield* Scope.make("sequential");
            yield* subscriber.pipe(Effect.forkIn(scope));
            yield* Ref.set(current, Option.some(scope));
          }),
        ),
      ),
    close: lifecycle.withPermits(1)(closeRaw),
  };
};
