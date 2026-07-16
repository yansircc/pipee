import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const rollbackStagingOnFailure = <A, E, R, E2, R2>(
  publish: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<unknown, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  publish.pipe(
    Effect.matchCauseEffect({
      onFailure: (publishCause) =>
        cleanup.pipe(
          Effect.matchCauseEffect({
            onFailure: (cleanupCause) =>
              Effect.failCause(Cause.combine(publishCause, cleanupCause)),
            onSuccess: () => Effect.failCause(publishCause),
          }),
        ),
      onSuccess: Effect.succeed,
    }),
  );
