import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import { makeStatusSync } from "../src/status-sync.ts";

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
