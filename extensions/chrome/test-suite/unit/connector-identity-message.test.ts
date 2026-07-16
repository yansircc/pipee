import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { requestConnectorIdentity } from "../../src/browser/connector-identity-message.js";

Object.assign(globalThis, {
  chrome: {
    runtime: {
      sendMessage: () => new Promise(() => undefined),
    },
  },
});

it.effect("fails when the service-worker identity owner does not reply", () =>
  Effect.gen(function* () {
    const request = yield* Effect.forkChild(
      requestConnectorIdentity({ type: "pi-chrome/connector/load" }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    const failure = yield* Fiber.join(request).pipe(Effect.flip);
    expect(failure.message).toBe("Timed out waiting for the connector identity owner");
  }),
);
