import { describe, expect, it } from "vite-plus/test";
import { formatInputResult, formatPageResult } from "../../src/pi/format.js";

describe("page result formatting", () => {
  it("reports the observed terminal tab after a redirect", () => {
    const text = formatPageResult(
      {
        operation: {
          kind: "navigate",
          url: "https://login.example.test/start",
        },
      },
      {
        id: 7,
        windowId: 3,
        active: true,
        highlighted: true,
        title: "Account",
        url: "https://app.example.test/account",
        status: "complete",
        groupId: -1,
        group: null,
      },
    );

    expect(text).toContain("Navigated to https://app.example.test/account");
    expect(text).toContain("requested: https://login.example.test/start");
    expect(text).toContain("title: Account");
    expect(text).toContain("status: complete");
  });

  it("does not repeat the requested URL when it is the observed URL", () => {
    const text = formatPageResult(
      {
        operation: {
          kind: "navigate",
          url: "https://example.test/",
        },
      },
      {
        url: "https://example.test/",
        title: "Example",
      },
    );

    expect(text).toBe("Navigated to https://example.test/\ntitle: Example");
  });

  it("renders text mode only from runtime-owned content blocks", () => {
    const text = formatPageResult(
      { operation: { kind: "snapshot", mode: "text" } },
      {
        title: "Search",
        url: "https://search.example.test/",
        mode: "text",
        text: "formatter must not render this parallel reading view",
        textSnippets: [{ uid: "legacy", text: "legacy snippet" }],
        pageMap: { headings: [{ uid: "legacy-heading", text: "legacy heading" }] },
        contentBlocks: [
          {
            kind: "heading",
            uid: "el-1",
            level: 3,
            text: "Result title",
            links: [
              {
                uid: "el-2",
                text: "Result title",
                href: "https://result.example.test/",
              },
            ],
          },
          {
            kind: "paragraph",
            uid: "el-3",
            text: "Result snippet",
            context: { uid: "el-4", label: "Result card" },
            links: [],
          },
        ],
      },
    );

    expect(text).toContain("### el-1 [Result title](https://result.example.test/)");
    expect(text).toContain("el-3 Result snippet");
    expect(text).toContain("context el-4 Result card");
    expect(text).not.toContain("parallel reading view");
    expect(text).not.toContain("legacy snippet");
    expect(text).not.toContain("legacy heading");
  });

  it("renders the Action Graph as directly callable refs and verbs", () => {
    const text = formatPageResult(
      { operation: { kind: "snapshot" } },
      {
        title: "Checkout",
        url: "https://shop.example.test/checkout",
        mode: "interactive",
        actions: [
          {
            id: "el-12",
            role: "button",
            name: "Submit order",
            state: {},
            verbs: ["click"],
          },
          {
            id: "el-13",
            role: "checkbox",
            name: "Accept terms",
            state: { checked: false },
            verbs: ["click"],
          },
        ],
      },
    );

    expect(text).toContain('@el-12 button "Submit order" [click]');
    expect(text).toContain('@el-13 checkbox "Accept terms" checked=false [click]');
  });

  it("renders semantic frontiers and bounded read coverage", () => {
    const snapshot = formatPageResult(
      { operation: { kind: "snapshot" } },
      {
        title: "Orders",
        url: "https://app.example.test/orders",
        mode: "interactive",
        actions: [],
        contexts: [
          {
            id: "el-9",
            role: "region",
            name: "Order history",
            shownActionCount: 0,
            actionCount: 143,
          },
        ],
        frontiers: [{ id: "frontier-1", name: "Order history", omittedCount: 143 }],
      },
    );
    const read = formatPageResult(
      { operation: { kind: "read", view: "content" } },
      {
        title: "Orders",
        url: "https://app.example.test/orders",
        view: "content",
        blocks: [{ kind: "paragraph", text: "Rendered signed-in content", links: [] }],
        frontiers: [{ id: "frontier-2", omittedCount: 12 }],
        coverage: {
          returnedBlocks: 1,
          totalBlocks: 13,
          returnedCharacters: 26,
          truncated: true,
        },
      },
    );

    expect(snapshot).toContain('@el-9 region "Order history" actions=0/143');
    expect(snapshot).toContain("@frontier-1");
    expect(read).toContain("blocks: 1/13");
    expect(read).toContain("Rendered signed-in content");
    expect(read).toContain("@frontier-2");
  });

  it("renders a nested navigation snapshot in the same result", () => {
    const text = formatPageResult(
      {
        operation: {
          kind: "navigate",
          url: "https://example.test/",
          snapshot: { mode: "text" },
        },
      },
      {
        tab: { url: "https://example.test/", title: "Example" },
        snapshot: {
          title: "Example",
          url: "https://example.test/",
          mode: "text",
          contentBlocks: [{ kind: "paragraph", uid: "el-1", text: "Loaded content", links: [] }],
        },
      },
    );

    expect(text).toContain("Navigated to https://example.test/");
    expect(text).toContain("# Chrome snapshot (text)");
    expect(text).toContain("el-1 Loaded content");
  });

  it("reports a wait deadline as a negative observation", () => {
    const text = formatPageResult(
      {
        operation: {
          kind: "wait",
          condition: { by: "selector", value: "article" },
        },
      },
      {
        satisfied: false,
        elapsedMs: 10_000,
        observation: {
          url: "https://news.example.test/",
          title: "News",
          readyState: "complete",
          bodyTextLength: 843,
          matchCount: 0,
        },
      },
    );

    expect(text).toContain("Wait condition not satisfied");
    expect(text).toContain("selector matches: 0");
    expect(text).toContain("url: https://news.example.test/");
  });
});

describe("input result formatting", () => {
  const call = {
    operation: {
      kind: "click",
      at: { by: "uid", value: "el-1" },
      includeSnapshot: true,
    },
  } as const;

  it("renders the action receipt and its successful verification", () => {
    const text = formatInputResult(call, {
      action: { outcome: "effect-observed", observedChanges: ["url", "page"] },
      verification: {
        status: "observed",
        snapshot: { title: "Inbox", url: "https://mail.test/", mode: "auto", actions: [] },
      },
    });

    expect(text).toContain("click completed: url, page");
    expect(text).toContain("# Chrome snapshot (auto)");
  });

  it("preserves the action outcome when verification is unavailable", () => {
    const text = formatInputResult(call, {
      action: { outcome: "effect-observed", observedChanges: ["page"] },
      verification: { status: "unavailable", reason: "page changed during snapshot" },
    });

    expect(text).toContain("click completed: page");
    expect(text).toContain("action result was preserved");
    expect(text).toContain("page changed during snapshot");
  });
});
