import { layer as NodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as NodePathLayer } from "@effect/platform-node/NodePath";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { acquireCrossProcessLease } from "../src/cross-process-lease.ts";

const [path, mode] = process.argv.slice(2);
if (path === undefined || (mode !== "hold" && mode !== "try")) process.exit(64);

const PlatformLive = Layer.mergeAll(NodeFileSystemLayer, NodePathLayer);
const program = acquireCrossProcessLease(path).pipe(
  Effect.tap(() => Effect.sync(() => process.stdout.write("acquired\n"))),
  Effect.andThen(mode === "hold" ? Effect.never : Effect.void),
  Effect.catchTag("LeaseUnavailable", () =>
    Effect.sync(() => process.stdout.write("unavailable\n")),
  ),
  Effect.scoped,
  Effect.provide(PlatformLive),
);

NodeRuntime.runMain(program);
