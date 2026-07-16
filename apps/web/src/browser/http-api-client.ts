import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { PiWebApi } from "@/api/contract"

type Client = HttpApiClient.ForApi<typeof PiWebApi>

export class PiWebHttpClient extends Context.Service<PiWebHttpClient, Client>()("pi-web/browser/PiWebHttpClient") {}

export const PiWebHttpClientLive = Layer.effect(
  PiWebHttpClient,
  HttpApiClient.make(PiWebApi).pipe(Effect.provide(FetchHttpClient.layer)),
)

export const withApi = <A, E, R>(
  use: (client: Client) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, PiWebHttpClient | R> => PiWebHttpClient.pipe(Effect.flatMap(use))

export const apiUrls = HttpApiClient.urlBuilder(PiWebApi)
