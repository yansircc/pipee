import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { projectWeixinWebView, WeixinWebAction } from "../src/web-surface.ts";

describe("Weixin Web Surface algebra", () => {
  it("decodes only finite bridge actions", () => {
    expect(
      Schema.decodeUnknownSync(WeixinWebAction)({ _tag: "SetEnabled", enabled: false }),
    ).toEqual({ _tag: "SetEnabled", enabled: false });
    expect(() =>
      Schema.decodeUnknownSync(WeixinWebAction)({ _tag: "Send", text: "open" }),
    ).toThrow();
  });

  it("projects account state without becoming a second owner", () => {
    expect(
      projectWeixinWebView(
        {
          running: true,
          enabled: true,
          authenticated: true,
          accountId: "wx-1",
          defaultSessionId: "session-1",
          sendReady: true,
          connection: { _tag: "Connected" },
        },
        "session-1",
        "/workspace",
      ),
    ).toMatchObject({ account: "wx-1", phase: "Connected", defaultSessionId: "session-1" });
  });
});
