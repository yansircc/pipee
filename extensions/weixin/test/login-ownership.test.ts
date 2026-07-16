import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, Ref } from "effect";
import { releaseSessionLogin } from "../src/login-ownership.ts";

it.effect("does not let session B shutdown cancel session A login", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const fiber = yield* Effect.never.pipe(
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    const owner = yield* Ref.make(Option.some({ ownerSessionId: "session-a", fiber }));

    yield* releaseSessionLogin(owner, "session-b");
    expect(fiber.pollUnsafe()).toBeUndefined();

    yield* releaseSessionLogin(owner, "session-a");
    yield* Deferred.await(interrupted);
    expect(fiber.pollUnsafe()).toBeDefined();
  }),
);
