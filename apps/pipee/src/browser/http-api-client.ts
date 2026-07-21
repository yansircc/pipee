import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { PipeeApi } from "@/api/contract"

type Client = HttpApiClient.ForApi<typeof PipeeApi>

export class PipeeHttpClient extends Context.Service<PipeeHttpClient, Client>()("pipee/browser/PipeeHttpClient") {}

export const PipeeHttpClientLive = Layer.effect(
  PipeeHttpClient,
  HttpApiClient.make(PipeeApi).pipe(Effect.provide(FetchHttpClient.layer)),
)

export const withApi = <A, E, R>(
  use: (client: Client) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, PipeeHttpClient | R> => PipeeHttpClient.pipe(Effect.flatMap(use))

export const apiUrls = HttpApiClient.urlBuilder(PipeeApi)
