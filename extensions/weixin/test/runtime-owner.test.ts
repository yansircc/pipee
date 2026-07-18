import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeProcessRuntimeOwner } from "../src/runtime.ts";

it.effect("transfers the retention anchor and disposes the last shared runtime", () =>
  Effect.gen(function* () {
    let disposed = 0;
    let created = 0;
    const owner = makeProcessRuntimeOwner(() => {
      created += 1;
      return {
        dispose: async () => {
          disposed += 1;
        },
      };
    });
    const sessionA: boolean[] = [];
    const sessionB: boolean[] = [];
    const runtimeA = owner.acquire({
      sessionId: "session-a",
      setRetained: (value) => sessionA.push(value),
    });
    const runtimeB = owner.acquire({
      sessionId: "session-b",
      setRetained: (value) => sessionB.push(value),
    });
    expect(runtimeA).toBe(runtimeB);
    expect(created).toBe(1);

    owner.setRetained(true);
    expect(sessionA.at(-1)).toBe(true);
    expect(sessionB.at(-1)).toBe(false);

    const transferred = owner.release("session-a");
    expect(transferred).toBeUndefined();
    expect(sessionA.at(-1)).toBe(false);
    expect(sessionB.at(-1)).toBe(true);
    expect(disposed).toBe(0);

    yield* Effect.promise(() => owner.release("session-b") as Promise<void>);
    expect(sessionB.at(-1)).toBe(false);
    expect(disposed).toBe(1);
  }),
);
