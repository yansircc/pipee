import { expect, it } from "@effect/vitest";
import { layer as NodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as NodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Exit, Layer, Scope } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCrossProcessLease, LeaseUnavailable } from "../src/cross-process-lease.ts";

const PlatformLive = Layer.mergeAll(NodeFileSystemLayer, NodePathLayer);

const withLeasePath = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "pipee-lease-"))),
    (directory) => use(join(directory, "owner.lease.sqlite")),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );

it.effect("allows exactly one owner and releases ownership with its scope", () =>
  withLeasePath((path) =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const owner = yield* acquireCrossProcessLease(path).pipe(
        Effect.provideService(Scope.Scope, ownerScope),
      );
      expect(owner.path).toBe(path);

      const contender = yield* acquireCrossProcessLease(path).pipe(Effect.scoped, Effect.flip);
      expect(contender).toBeInstanceOf(LeaseUnavailable);

      yield* Scope.close(ownerScope, Exit.succeed(undefined));
      const next = yield* acquireCrossProcessLease(path).pipe(Effect.scoped);
      expect(next.path).toBe(path);
    }),
  ).pipe(Effect.provide(PlatformLive)),
);

it.effect("closing a failed contender cannot release the current owner", () =>
  withLeasePath((path) =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      yield* acquireCrossProcessLease(path).pipe(Effect.provideService(Scope.Scope, ownerScope));

      yield* acquireCrossProcessLease(path).pipe(Effect.scoped, Effect.flip);
      const secondContender = yield* acquireCrossProcessLease(path).pipe(
        Effect.scoped,
        Effect.flip,
      );
      expect(secondContender).toBeInstanceOf(LeaseUnavailable);

      yield* Scope.close(ownerScope, Exit.succeed(undefined));
    }),
  ).pipe(Effect.provide(PlatformLive)),
);
