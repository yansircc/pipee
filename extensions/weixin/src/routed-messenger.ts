import { Clock, Effect } from "effect";
import type { RouteConflictError, RouteStoreError } from "./errors.ts";
import type { WeixinTransport, OutboundReceipt, WeixinTransportError } from "./ilink.ts";
import type { RouteStore } from "./route-store.ts";
import type { WeixinAuth } from "./schema.ts";

export interface RoutedTextInput {
  readonly auth: WeixinAuth;
  readonly sourceSessionId: string;
  readonly text: string;
  readonly contextToken: string;
  readonly clientId: string;
}

export interface RoutedMessenger {
  readonly sendText: (
    input: RoutedTextInput,
  ) => Effect.Effect<OutboundReceipt, WeixinTransportError | RouteStoreError | RouteConflictError>;
}

export const makeRoutedMessenger = (
  transport: WeixinTransport,
  routes: RouteStore,
): RoutedMessenger => ({
  sendText: (input) =>
    routes.withSendPermit(
      Effect.gen(function* () {
        const receipt = yield* transport.sendText(
          input.auth,
          input.auth.userId,
          input.text,
          input.contextToken,
          input.clientId,
        );
        yield* routes.record({
          accountId: input.auth.accountId,
          serverMessageId: receipt.serverMessageId,
          sourceSessionId: input.sourceSessionId,
          clientId: receipt.clientId,
          createdAt: yield* Clock.currentTimeMillis,
        });
        return receipt;
      }),
    ),
});
