import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { RouteConflictError } from "../src/errors.ts";
import { makeStateStore } from "../src/state.ts";
import { withTestStore } from "./runtime.ts";

const route = {
  accountId: "account-a",
  serverMessageId: "7483914874329324552",
  sourceSessionId: "session-a",
  clientId: "client-a",
  createdAt: 1,
} as const;

it.effect("persists exact outbound routes across store instances", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.routes.record(route);
      const restarted = yield* makeStateStore(store.path);
      expect(yield* restarted.routes.resolve(route.accountId, route.serverMessageId)).toBe(
        "session-a",
      );
      expect(yield* restarted.routes.resolve("account-b", route.serverMessageId)).toBeUndefined();
    }),
  ),
);

it.effect("rejects one server message id being assigned to two sessions", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.routes.record(route);
      const error = yield* store.routes
        .record({ ...route, sourceSessionId: "session-b", clientId: "client-b" })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(RouteConflictError);
      expect(yield* store.routes.resolve(route.accountId, route.serverMessageId)).toBe("session-a");
    }),
  ),
);
