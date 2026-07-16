import { Effect, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { HttpRequestError } from "./errors.ts";

export interface JsonHttpRequest {
  readonly operation: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeout?: `${number} millis` | `${number} seconds`;
}

export interface JsonHttpClient {
  readonly request: (request: JsonHttpRequest) => Effect.Effect<unknown, HttpRequestError>;
  readonly stream: (request: JsonHttpRequest) => Stream.Stream<unknown, HttpRequestError>;
  readonly bytes: (
    request: JsonHttpRequest,
    maxBytes: number,
  ) => Effect.Effect<Uint8Array, HttpRequestError>;
}

interface ByteChunkNode {
  readonly chunk: Uint8Array;
  readonly previous?: ByteChunkNode;
}

export const makeJsonHttpClient = (client: HttpClient.HttpClient): JsonHttpClient => {
  const execute = (input: JsonHttpRequest) => {
    const request =
      input.method === "GET"
        ? Effect.succeed(HttpClientRequest.get(input.url))
        : HttpClientRequest.post(input.url).pipe(HttpClientRequest.bodyJson(input.body ?? {}));
    const responseEffect = request.pipe(
      Effect.map((value) =>
        input.headers ? HttpClientRequest.setHeaders(value, input.headers) : value,
      ),
      Effect.flatMap(client.execute),
      Effect.mapError(
        (cause) =>
          new HttpRequestError({
            operation: input.operation,
            url: input.url,
            cause,
          }),
      ),
    );
    return input.timeout
      ? responseEffect.pipe(
          Effect.timeoutOrElse({
            duration: input.timeout,
            orElse: () =>
              Effect.fail(
                new HttpRequestError({
                  operation: input.operation,
                  url: input.url,
                  cause: "timeout",
                }),
              ),
          }),
        )
      : responseEffect;
  };

  const decodeJson = (input: JsonHttpRequest, response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(
        (cause) =>
          new HttpRequestError({
            operation: input.operation,
            url: input.url,
            cause,
            status: response.status,
          }),
      ),
    );

  const requireSuccess = (
    input: JsonHttpRequest,
    response: HttpClientResponse.HttpClientResponse,
    body: unknown,
  ) =>
    response.status >= 200 && response.status < 300
      ? Effect.succeed(body)
      : Effect.fail(
          new HttpRequestError({
            operation: input.operation,
            url: input.url,
            cause: `HTTP ${response.status}`,
            status: response.status,
            responseBody: body,
          }),
        );

  return {
    request: (input) =>
      execute(input).pipe(
        Effect.flatMap((response) =>
          decodeJson(input, response).pipe(
            Effect.flatMap((body) => requireSuccess(input, response, body)),
          ),
        ),
      ),
    stream: (input) =>
      Stream.unwrap(
        execute(input).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(
                  response.stream.pipe(
                    Stream.decodeText,
                    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
                    Stream.map((event) => event.data),
                    Stream.mapError(
                      (cause) =>
                        new HttpRequestError({
                          operation: input.operation,
                          url: input.url,
                          cause,
                          status: response.status,
                        }),
                    ),
                  ),
                )
              : decodeJson(input, response).pipe(
                  Effect.flatMap((body) => requireSuccess(input, response, body)),
                  Effect.map(() => Stream.empty),
                ),
          ),
        ),
      ),
    bytes: (input, maxBytes) =>
      execute(input).pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.stream.pipe(
                Stream.mapError(
                  (cause) =>
                    new HttpRequestError({
                      operation: input.operation,
                      url: input.url,
                      cause,
                      status: response.status,
                    }),
                ),
                Stream.runFoldEffect(
                  () => ({ head: undefined as ByteChunkNode | undefined, total: 0 }),
                  (state, chunk) => {
                    const total = state.total + chunk.byteLength;
                    return total > maxBytes
                      ? Effect.fail(
                          new HttpRequestError({
                            operation: input.operation,
                            url: input.url,
                            cause: `Response exceeds ${maxBytes} bytes`,
                            status: response.status,
                          }),
                        )
                      : Effect.succeed({
                          head: { chunk, ...(state.head ? { previous: state.head } : {}) },
                          total,
                        });
                  },
                ),
                Effect.map(({ head, total }) => {
                  const result = new Uint8Array(total);
                  let offset = total;
                  let current = head;
                  while (current) {
                    offset -= current.chunk.byteLength;
                    result.set(current.chunk, offset);
                    current = current.previous;
                  }
                  return result;
                }),
              )
            : Effect.fail(
                new HttpRequestError({
                  operation: input.operation,
                  url: input.url,
                  cause: `HTTP ${response.status}`,
                  status: response.status,
                }),
              ),
        ),
      ),
  };
};
