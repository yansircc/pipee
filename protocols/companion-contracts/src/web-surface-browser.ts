import { Option, Schema } from "effect";
import {
  WEB_SURFACE_CHANNEL_CONTRACT,
  WebSurfaceHostMessage,
  type JsonValue,
  type WebSurfaceActionOutcome,
  type WebSurfaceHostMessage as HostMessage,
} from "./web-surface.ts";

export interface WebSurfaceBrowserClient {
  readonly dispatch: (payload: JsonValue) => Promise<WebSurfaceActionOutcome>;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly navigate: (path: string) => void;
  readonly notify: (message: string, level?: "info" | "warning" | "error") => void;
}

export interface WebSurfaceBrowserCallbacks {
  readonly projection: (view: JsonValue | null) => void;
  readonly closed?: (reason: string) => void;
}

const decodeHostMessage = Schema.decodeUnknownOption(WebSurfaceHostMessage);

export const connectWebSurfaceBrowser = (
  callbacks: WebSurfaceBrowserCallbacks,
): Promise<WebSurfaceBrowserClient> =>
  new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data !== "object" ||
        event.data === null ||
        !("type" in event.data) ||
        event.data.type !== "pi-suite-web-surface-port" ||
        !("contract" in event.data) ||
        event.data.contract !== WEB_SURFACE_CHANNEL_CONTRACT ||
        event.ports.length !== 1
      ) {
        return;
      }
      globalThis.removeEventListener("message", listener);
      const port = event.ports[0]!;
      const pendingActions = new Map<string, (outcome: WebSurfaceActionOutcome) => void>();
      const pendingConfirms = new Map<string, (confirmed: boolean) => void>();
      let requestSequence = 0;
      const requestId = () => `surface-${Date.now()}-${++requestSequence}`;
      const post = (message: object) => port.postMessage(message);
      const closePending = () => {
        for (const settle of pendingActions.values()) {
          settle({ _tag: "Rejected", reason: "closed" });
        }
        for (const settle of pendingConfirms.values()) settle(false);
        pendingActions.clear();
        pendingConfirms.clear();
      };
      port.onmessage = (messageEvent) => {
        const decoded = decodeHostMessage(messageEvent.data);
        if (Option.isNone(decoded)) return;
        const message: HostMessage = decoded.value;
        if (message._tag === "init" || message._tag === "projection") {
          callbacks.projection(message.surface.view);
        } else if (message._tag === "action-result") {
          pendingActions.get(message.requestId)?.(message.outcome);
          pendingActions.delete(message.requestId);
        } else if (message._tag === "confirm-result") {
          pendingConfirms.get(message.requestId)?.(message.confirmed);
          pendingConfirms.delete(message.requestId);
        } else if (message._tag === "closed") {
          closePending();
          callbacks.closed?.(message.reason);
          port.close();
        }
      };
      port.start();
      const client: WebSurfaceBrowserClient = {
        dispatch: (payload) =>
          new Promise((settle) => {
            const id = requestId();
            pendingActions.set(id, settle);
            post({ _tag: "dispatch", requestId: id, payload });
          }),
        confirm: (title, message) =>
          new Promise((settle) => {
            const id = requestId();
            pendingConfirms.set(id, settle);
            post({ _tag: "confirm", requestId: id, title, message });
          }),
        navigate: (path) => post({ _tag: "navigate", path }),
        notify: (message, level = "info") => post({ _tag: "notify", message, level }),
      };
      post({ _tag: "ready", contract: WEB_SURFACE_CHANNEL_CONTRACT });
      resolve(client);
    };
    globalThis.addEventListener("message", listener);
  });
