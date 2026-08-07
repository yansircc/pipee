import { Context, Effect, FileSystem, Layer, Path } from "effect"
import {
  makeZeroYConnectionRegistry,
  type ZeroYConnectionRegistryHandle,
} from "@pipee/host-runtime/zeroy-connection-registry"

/**
 * Shared zeroY connection registry singleton.
 *
 * The same registry handle backs the Pipee connection API (list/pair/exchange/
 * revoke) and the extension capability projection. A single instance keeps
 * the connection directory, in-memory rows, secret storage, and subscription
 * listeners coherent across both surfaces; mutation via one is immediately
 * visible to the other.
 */

export class ZeroYConnectionRegistryProvider extends Context.Service<
  ZeroYConnectionRegistryProvider,
  ZeroYConnectionRegistryHandle
>()("pipee/server/ZeroYConnectionRegistryProvider") {}

const connectionDirectory = (home: string): string => `${home}/.pipee/zeroy`

export const ZeroYConnectionRegistryProviderLive: Layer.Layer<
  ZeroYConnectionRegistryProvider,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  ZeroYConnectionRegistryProvider,
  Effect.gen(function* () {
    yield* FileSystem.FileSystem
    yield* Path.Path
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
    const directory = connectionDirectory(home)
    const registry = makeZeroYConnectionRegistry()
    yield* registry.load(directory).pipe(Effect.ignore)
    return registry
  }),
)
