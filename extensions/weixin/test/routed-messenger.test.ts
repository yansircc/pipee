import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { WeixinTransport } from "../src/ilink.ts";
import { makeRoutedMessenger } from "../src/routed-messenger.ts";
import { withTestStore } from "./runtime.ts";

it.effect("sends and durably records the server receipt as one outbound operation", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      const transport: WeixinTransport = {
        login: () => Effect.never,
        getUpdates: () => Effect.succeed({}),
        sendText: (_auth, _to, _text, _context, clientId) =>
          Effect.succeed({ serverMessageId: "7483914874329324552", clientId }),
        startTyping: (_auth, userId) => Effect.succeed({ userId, ticket: "ticket" }),
        stopTyping: () => Effect.void,
        notifyStart: () => Effect.void,
        notifyStop: () => Effect.void,
        downloadImage: () => Effect.die("unused"),
      };
      const receipt = yield* makeRoutedMessenger(transport, store.routes).sendText({
        auth: {
          token: "token",
          baseUrl: "https://example.test",
          accountId: "account-a",
          userId: "user-a",
          savedAt: "now",
        },
        sourceSessionId: "session-a",
        text: "report",
        contextToken: "context",
        clientId: "client-a",
      });
      expect(receipt.serverMessageId).toBe("7483914874329324552");
      expect(yield* store.routes.resolve("account-a", receipt.serverMessageId)).toBe("session-a");
    }),
  ),
);
