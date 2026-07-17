import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { ProtocolFailure } from "../../src/core/errors.js";
import { ownerServerProof } from "../../src/pi/bridge-authentication-node.js";
import {
  forwardCommandToOwner,
  handshakeWithOwner,
  statusFromOwner,
} from "../../src/pi/bridge-owner-client.js";
import { decodeDomainRequest, projectDomainRequest } from "../../src/protocol/codec.js";
import {
  BRIDGE_ROUTES,
  REQUEST_BODY_BYTE_LIMIT,
  responseBodyLimitForRoute,
} from "../../src/protocol/bridge-contract.js";
import {
  OWNER_CLIENT_NONCE_HEADER,
  type BridgeOwnerIdentity,
} from "../../src/protocol/bridge-owner.js";

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type ListeningServer = { readonly server: Server; readonly url: string };

const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Effect.Effect<ListeningServer, TestFailure> =>
  Effect.callback((resume) => {
    const server = createServer(handler);
    const onError = (cause: unknown) =>
      resume(Effect.fail(new TestFailure({ message: "owner server failed", cause })));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : undefined;
      resume(
        port === undefined
          ? Effect.fail(new TestFailure({ message: "owner server has no port" }))
          : Effect.succeed({ server, url: `http://127.0.0.1:${port}` }),
      );
    });
    return Effect.sync(() => server.close());
  });

const close = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const withOwner = <A, E>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  use: (url: string) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* listen(handler);
      yield* Effect.addFinalizer(() => close(owner.server));
      return yield* use(owner.url);
    }),
  );

const identity = {
  credential: "a".repeat(64),
  protocolFingerprint: "f".repeat(64),
} satisfies BridgeOwnerIdentity;

const authenticatedOwnerHandler = (
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  options: {
    readonly displayVersion?: string;
    readonly protocolFingerprint?: string;
    readonly onHandshake?: () => void;
  } = {},
) => {
  let sequence = 0;
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (
      request.method === BRIDGE_ROUTES.ownerHandshake.method &&
      request.url === BRIDGE_ROUTES.ownerHandshake.path
    ) {
      const challenge = {
        bridgeEpoch: "b".repeat(64),
        requestNonce: (sequence++).toString(16).padStart(64, "0"),
      } as const;
      options.onHandshake?.();
      const clientNonce = String(request.headers[OWNER_CLIENT_NONCE_HEADER] ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          bridgeDisplayVersion: options.displayVersion ?? "0.16.0",
          protocolFingerprint: options.protocolFingerprint ?? identity.protocolFingerprint,
          ...challenge,
          proof: ownerServerProof(identity, clientNonce, challenge),
        }),
      );
      return;
    }
    handle(request, response);
  };
};

const request = { domain: "tab", call: { op: "list" } } as const;
const session = { key: "session", groupTitle: "Session", foreground: false } as const;
it.live("gates owner compatibility by fingerprint, not display version", () =>
  Effect.gen(function* () {
    yield* withOwner(
      authenticatedOwnerHandler((_request, response) => response.writeHead(404).end(), {
        displayVersion: "99.0.0",
      }),
      (url) => handshakeWithOwner(url, identity),
    );

    const failure = yield* withOwner(
      authenticatedOwnerHandler((_request, response) => response.writeHead(404).end(), {
        protocolFingerprint: "b".repeat(64),
      }),
      (url) => handshakeWithOwner(url, identity),
    ).pipe(Effect.flip);
    expect(failure.message).toContain("protocol fingerprint");
  }),
);

it.live("does not disclose the owner credential before listener authentication", () => {
  let requests = 0;
  const observedHeaders: Array<IncomingMessage["headers"]> = [];
  return withOwner(
    (request, response) => {
      requests += 1;
      observedHeaders.push(request.headers);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          bridgeDisplayVersion: "0.16.0",
          protocolFingerprint: identity.protocolFingerprint,
          bridgeEpoch: "b".repeat(64),
          requestNonce: "c".repeat(64),
          proof: "d".repeat(64),
        }),
      );
    },
    (url) =>
      Effect.gen(function* () {
        const failure = yield* statusFromOwner(url, identity).pipe(Effect.flip);
        expect(failure.message).toContain("prove owner credential possession");
        expect(requests).toBe(1);
        expect(JSON.stringify(observedHeaders)).not.toContain(identity.credential);
        expect(Object.keys(observedHeaders[0]!)).not.toContain("x-pi-chrome-owner-credential");
      }),
  );
});

it.live("bounds the unauthenticated owner handshake response", () =>
  withOwner(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(responseBodyLimitForRoute("ownerHandshake") + 1));
    },
    (url) =>
      Effect.gen(function* () {
        const failure = yield* handshakeWithOwner(url, identity).pipe(Effect.flip);
        expect(failure.message).toContain(
          `exceeds ${responseBodyLimitForRoute("ownerHandshake")} bytes`,
        );
      }),
  ),
);

it.live("reconstructs a typed owner failure", () =>
  withOwner(
    authenticatedOwnerHandler((_request, response) => {
      response.writeHead(504, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error: { _tag: "CommandRejected", code: "browser-operation", message: "rejected" },
        }),
      );
    }),
    (url) =>
      Effect.gen(function* () {
        const failure = yield* forwardCommandToOwner(
          url,
          identity,
          request,
          session,
          500,
          Effect.void,
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "CommandRejected",
          code: "browser-operation",
          message: "rejected",
        });
      }),
  ),
);

it.live("treats every untyped owner response as an unknown command outcome", () =>
  withOwner(
    authenticatedOwnerHandler((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "owner proof does not match" }));
    }),
    (url) =>
      Effect.gen(function* () {
        const failure = yield* forwardCommandToOwner(
          url,
          identity,
          request,
          session,
          500,
          Effect.void,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("CommandOutcomeUnknown");
      }),
  ),
);

it.live("revalidates guarded client submissions after the owner handshake and before POST", () => {
  let handshakeCompleted = false;
  let commandRequests = 0;
  let admissionChecks = 0;
  return withOwner(
    authenticatedOwnerHandler(
      (_request, response) => {
        commandRequests += 1;
        response.writeHead(500).end();
      },
      { onHandshake: () => (handshakeCompleted = true) },
    ),
    (url) =>
      Effect.gen(function* () {
        const failure = yield* forwardCommandToOwner(
          url,
          identity,
          request,
          session,
          500,
          Effect.suspend(() => {
            admissionChecks += 1;
            return handshakeCompleted
              ? Effect.fail(new TestFailure({ message: "authorization was revoked" }))
              : Effect.fail(new TestFailure({ message: "admission ran before owner handshake" }));
          }),
        ).pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "TestFailure",
          message: "authorization was revoked",
        });
        expect(admissionChecks).toBe(1);
        expect(commandRequests).toBe(0);
      }),
  );
});

it.live("sends only the projected wire request to the owner", () => {
  let body = "";
  return withOwner(
    authenticatedOwnerHandler((incoming, response) => {
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, value: null }));
      });
    }),
    (url) =>
      Effect.gen(function* () {
        const toolRequest = yield* decodeDomainRequest("page", {
          background: true,
          op: "screenshot",
          format: "png",
          capture: {
            kind: "viewport",
            path: ".pi/chrome-screenshots/owner-private.png",
          },
        });
        yield* forwardCommandToOwner(
          url,
          identity,
          projectDomainRequest(toolRequest),
          session,
          500,
          Effect.void,
        );

        expect(JSON.parse(body)).toMatchObject({
          domain: "page",
          call: {
            operation: {
              kind: "screenshot",
              format: "png",
              capture: { kind: "viewport" },
            },
          },
        });
        expect(body).not.toMatch(/path|directory|background/);
      }),
  );
});

it.live("rejects an oversized owner request before network dispatch", () =>
  Effect.gen(function* () {
    const failure = yield* forwardCommandToOwner(
      "http://127.0.0.1:1",
      identity,
      {
        domain: "page",
        call: {
          operation: {
            kind: "evaluate",
            expression: "x".repeat(REQUEST_BODY_BYTE_LIMIT),
          },
        },
      },
      session,
      500,
      Effect.void,
    ).pipe(Effect.flip);

    expect(failure).toBeInstanceOf(ProtocolFailure);
  }),
);
