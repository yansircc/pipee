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
      yield* Effect.sync(() =>
        process.stdout.write(
          `${JSON.stringify({ access: repository.projectAccess, ids: occurrences.map(({ id }) => id) })}\n`,
        ),
      );
      return yield* Effect.never;
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);
