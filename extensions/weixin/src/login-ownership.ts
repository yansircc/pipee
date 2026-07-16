import { Effect, Fiber, Option, Ref } from "effect";

export type OwnedLoginFiber<A, E> = {
  readonly ownerSessionId: string;
  readonly fiber: Fiber.Fiber<A, E>;
};

export const cancelLogin = <A, E>(owner: Ref.Ref<Option.Option<OwnedLoginFiber<A, E>>>) =>
  Ref.getAndSet(owner, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ fiber }) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      }),
    ),
  );

export const releaseSessionLogin = <A, E>(
  owner: Ref.Ref<Option.Option<OwnedLoginFiber<A, E>>>,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(owner);
    if (Option.isNone(current) || current.value.ownerSessionId !== sessionId) return;
    yield* Ref.set(owner, Option.none());
    yield* Fiber.interrupt(current.value.fiber);
  });

export const clearLogin = <A, E>(
  owner: Ref.Ref<Option.Option<OwnedLoginFiber<A, E>>>,
  fiber: Fiber.Fiber<A, E>,
) =>
  Ref.update(owner, (current) =>
    Option.isSome(current) && current.value.fiber === fiber ? Option.none() : current,
  );
