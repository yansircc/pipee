import { describe, expect, it } from "vite-plus/test";
import { projectSessionGroupTitle } from "../../src/pi/session-group-title.js";

const userEntry = (content: unknown) => ({
  type: "message",
  message: { role: "user", content },
});

describe("session group title", () => {
  it("projects the canonical Pi session name", () => {
    expect(
      projectSessionGroupTitle("019f6de9-0811", "  修复 Chrome   配对  ", [userEntry("ignored")]),
    ).toBe("Pi · 修复 Chrome 配对");
  });

  it("derives an unnamed session from its first user message", () => {
    expect(
      projectSessionGroupTitle("019f6de9-0811", undefined, [
        { type: "model_change" },
        userEntry([{ type: "text", text: "把消息列表改成默认追随最新输出" }]),
      ]),
    ).toBe("Pi · 把消息列表改成默认追随最新输出");
  });

  it("uses a short stable fallback without exposing the full session id", () => {
    expect(projectSessionGroupTitle("019f6de9-0811-7f92-b103", undefined, [])).toBe(
      "Pi · 019f6de9",
    );
  });
});
