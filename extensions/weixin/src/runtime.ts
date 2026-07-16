import { layer as NodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as NodePathLayer } from "@effect/platform-node/NodePath";
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Bridge, BridgeLive } from "./bridge.ts";

const PlatformLive = Layer.mergeAll(NodeFileSystemLayer, NodePathLayer, FetchHttpClient.layer);

const AppLive = BridgeLive.pipe(Layer.provide(PlatformLive));

export type PiWeixinRuntime = ManagedRuntime.ManagedRuntime<Bridge, unknown>;

declare global {
  var __piWeixinRuntime: PiWeixinRuntime | undefined;
}

export const getPiWeixinRuntime = (): PiWeixinRuntime => {
  if (!globalThis.__piWeixinRuntime) {
    globalThis.__piWeixinRuntime = ManagedRuntime.make(AppLive) as PiWeixinRuntime;
  }
  return globalThis.__piWeixinRuntime;
};
