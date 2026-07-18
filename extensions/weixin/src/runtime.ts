import { layer as NodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as NodePathLayer } from "@effect/platform-node/NodePath";
import { Layer, ManagedRuntime, Ref } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Bridge, BridgeLive } from "./bridge.ts";

const PlatformLive = Layer.mergeAll(NodeFileSystemLayer, NodePathLayer, FetchHttpClient.layer);
const AppLive = BridgeLive.pipe(Layer.provide(PlatformLive));

export type PiWeixinRuntime = ManagedRuntime.ManagedRuntime<Bridge, unknown>;

export interface RuntimeConsumer {
  readonly sessionId: string;
  readonly setRetained: (retained: boolean) => void;
}

interface DisposableRuntime {
  readonly dispose: () => Promise<void>;
}

interface RuntimeOwnerState<R extends DisposableRuntime> {
  readonly runtime?: R;
  readonly consumers: ReadonlyMap<string, RuntimeConsumer>;
  readonly retained: boolean;
}

const projectRetention = <R extends DisposableRuntime>(state: RuntimeOwnerState<R>): void => {
  const anchor = state.retained ? state.consumers.keys().next().value : undefined;
  for (const consumer of state.consumers.values()) {
    consumer.setRetained(consumer.sessionId === anchor);
  }
};

export interface ProcessRuntimeOwner<R extends DisposableRuntime> {
  readonly acquire: (consumer: RuntimeConsumer) => R;
  readonly setRetained: (retained: boolean) => void;
  readonly release: (sessionId: string) => Promise<void> | void;
}

export const makeProcessRuntimeOwner = <R extends DisposableRuntime>(
  createRuntime: () => R,
): ProcessRuntimeOwner<R> => {
  const owner = Ref.makeUnsafe<RuntimeOwnerState<R>>({ consumers: new Map(), retained: false });
  return {
    acquire: (consumer) => {
      const current = Ref.getUnsafe(owner);
      const runtime = current.runtime ?? createRuntime();
      const consumers = new Map(current.consumers);
      consumers.set(consumer.sessionId, consumer);
      const next = { ...current, runtime, consumers };
      owner.ref.current = next;
      projectRetention(next);
      return runtime;
    },
    setRetained: (retained) => {
      const current = Ref.getUnsafe(owner);
      const next = { ...current, retained };
      owner.ref.current = next;
      projectRetention(next);
    },
    release: (sessionId) => {
      const current = Ref.getUnsafe(owner);
      const consumers = new Map(current.consumers);
      const removed = consumers.get(sessionId);
      consumers.delete(sessionId);
      removed?.setRetained(false);
      if (consumers.size > 0) {
        const next = { ...current, consumers };
        owner.ref.current = next;
        projectRetention(next);
        return;
      }
      owner.ref.current = { consumers, retained: false };
      return current.runtime?.dispose();
    },
  };
};

declare global {
  var __piWeixinRuntimeOwner: ProcessRuntimeOwner<PiWeixinRuntime> | undefined;
}

const processOwner =
  globalThis.__piWeixinRuntimeOwner ??
  (globalThis.__piWeixinRuntimeOwner = makeProcessRuntimeOwner(
    () => ManagedRuntime.make(AppLive) as PiWeixinRuntime,
  ));

export const acquirePiWeixinRuntime = processOwner.acquire;
export const setPiWeixinRetention = processOwner.setRetained;
export const releasePiWeixinRuntime = processOwner.release;
