import { expect, it } from "@effect/vitest";
import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import { projectWeixinLivePresentation } from "../src/presentation.ts";
import { publishSessionPresentation, type WeixinStatusProjection } from "../src/session-status.ts";

const status = (connected: boolean): WeixinStatusProjection => ({
  kind: "pi-weixin/status",
  version: 3,
  enabled: connected,
  accountId: "wx-bot-1",
  defaultSessionId: "session-a",
  connected,
  sendReady: connected,
  phase: connected ? "Connected" : "Stopped",
});

it("publishes presentation state when the host supports it", () => {
  const documents: Array<ReturnType<typeof projectWeixinLivePresentation> | undefined> = [];
  const presentation: LivePresentationPort = {
    replace: (_slot, value): void => {
      documents.push(value);
    },
  };

  publishSessionPresentation(presentation, status(true));
  publishSessionPresentation(presentation, status(false));

  expect(documents).toEqual([
    projectWeixinLivePresentation(status(true)),
    projectWeixinLivePresentation(status(false)),
  ]);
});

it("does nothing when the host does not provide live presentation", () => {
  expect(() => publishSessionPresentation(undefined, status(true))).not.toThrow();
});
