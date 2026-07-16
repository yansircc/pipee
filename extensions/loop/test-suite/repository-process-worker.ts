import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { makeLoopRepository } from "../src/application/repository.ts";
import { DEFAULT_CONFIG } from "../src/domain/model.ts";

const [cwd] = process.argv.slice(2);
if (cwd === undefined) process.exit(64);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const repository = yield* makeLoopRepository(cwd, DEFAULT_CONFIG);
      const occurrences = yield* repository.claimDue(10, "open", "project");
      const access = yield* repository.projectAccess;
      yield* Effect.sync(() =>
        process.stdout.write(
          `${JSON.stringify({ access, ids: occurrences.map(({ id }) => id) })}\n`,
        ),
      );
      if (access === "owner") return yield* Effect.never;
      const awaitTakeover = (): Effect.Effect<void, never> =>
        Effect.sleep("20 millis").pipe(
          Effect.andThen(repository.claimDue(20, "open", "project")),
          Effect.flatMap((claimed) =>
            repository.projectAccess.pipe(
              Effect.flatMap((currentAccess) =>
                currentAccess === "follower"
                  ? Effect.suspend(awaitTakeover)
                  : Effect.sync(() =>
                      process.stdout.write(
                        `${JSON.stringify({ access: currentAccess, ids: claimed.map(({ id }) => id) })}\n`,
                      ),
                    ),
              ),
            ),
          ),
          Effect.catch(() => Effect.suspend(awaitTakeover)),
        );
      return yield* awaitTakeover();
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);
