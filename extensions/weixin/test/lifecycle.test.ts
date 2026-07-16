import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { bindAfterDispatchBarrier } from "../src/bridge.ts";
import { makeStatusSync } from "../src/status-sync.ts";

it.effect(
  "bind waits for the old dispatch fiber before publishing and starting the new binding",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const oldDispatch = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Ref.update(events, (current) => [...current, "old-stopped"]).pipe(
            Effect.andThen(Deferred.succeed(stopped, undefined)),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);

      yield* bindAfterDispatchBarrier(
        Fiber.interrupt(oldDispatch).pipe(Effect.asVoid),
        Deferred.await(stopped).pipe(
          Effect.andThen(Ref.update(events, (current) => [...current, "binding-persisted"])),
        ),
        Ref.update(events, (current) => [...current, "new-started"]),
      );

      expect(yield* Ref.get(events)).toEqual(["old-stopped", "binding-persisted", "new-started"]);
    }),
);

it.effect("status synchronization closes exactly the replaced session scope", () =>
  Effect.gen(function* () {
    const sync = makeStatusSync();
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const closed = yield* Ref.make<ReadonlyArray<string>>([]);
    const subscriber = (id: string, started: Deferred.Deferred<void>) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.update(closed, (current) => [...current, id])),
      );

    yield* sync.replace(subscriber("first", firstStarted));
    yield* Deferred.await(firstStarted);
    yield* sync.replace(subscriber("second", secondStarted));
    yield* Deferred.await(secondStarted);
    expect(yield* Ref.get(closed)).toEqual(["first"]);

    yield* sync.close;
    expect(yield* Ref.get(closed)).toEqual(["first", "second"]);
  }),
);
