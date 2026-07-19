import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { LoopWebAction, projectLoopWebView } from "../src/pi/web-surface.js";

describe("Loop Web Surface algebra", () => {
  it("keeps run-now separate from pause and resume", () => {
    expect(Schema.decodeUnknownSync(LoopWebAction)({ _tag: "RunNow", id: "loop-1" })).toEqual({
      _tag: "RunNow",
      id: "loop-1",
    });
    expect(
      Schema.decodeUnknownSync(LoopWebAction)({ _tag: "SetEnabled", id: "loop-1", enabled: false }),
    ).toMatchObject({ _tag: "SetEnabled", enabled: false });
  });

  it("does not admit retention in the edit action", () => {
    expect(() =>
      Schema.decodeUnknownSync(LoopWebAction, { onExcessProperty: "error" })({
        _tag: "Update",
        id: "loop-1",
        label: null,
        prompt: "check",
        schedule: { kind: "dynamic" },
        retention: "project",
      }),
    ).toThrow();
    expect(projectLoopWebView([], "session-1", 42)).toMatchObject({ loops: [], observedAt: 42 });
  });
});
