import { runInNewContext } from "node:vm";
import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const inputMocks = vi.hoisted(() => ({
  attachDebugger: vi.fn(),
  bringToFront: vi.fn(),
  cdp: vi.fn(),
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: inputMocks.attachDebugger,
  cdp: inputMocks.cdp,
  rng: vi.fn(() => 0),
  sleep: vi.fn(),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: inputMocks.bringToFront,
}));

vi.mock("../../src/browser/platform-input-shared.js", () => ({
  cdpMoveTo: vi.fn(),
  pickInsideRect: vi.fn(),
  resolveTargetInTab: vi.fn(),
}));

let chromeInputUpload: typeof import("../../src/browser/platform-input-pointer.js").chromeInputUpload;
let fileInput: {
  readonly tagName: string;
  readonly type: string;
  scrollIntoView: ReturnType<typeof vi.fn>;
};
let eventDispatchError: Error | undefined;

beforeAll(async () => {
  ({ chromeInputUpload } = await import("../../src/browser/platform-input-pointer.js"));
});

beforeEach(() => {
  fileInput = {
    tagName: "INPUT",
    type: "file",
    scrollIntoView: vi.fn(),
  };
  inputMocks.attachDebugger.mockClear();
  inputMocks.bringToFront.mockClear();
  eventDispatchError = undefined;
  inputMocks.cdp.mockReset();
  inputMocks.cdp.mockImplementation(
    async (_tabId: number, method: string, params: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        const resolved = runInNewContext(String(params.expression), {
          window: {
            __PI_CHROME_STATE__: {
              refs: new Map([
                [
                  "el-file",
                  {
                    kind: "element",
                    element: fileInput,
                    verbs: new Set(["upload"]),
                    context: false,
                  },
                ],
              ]),
            },
          },
        });
        expect(resolved).toBe(fileInput);
        return { result: { objectId: "file-input-object" } };
      }
      if (method === "DOM.requestNode") return { nodeId: 17 };
      if (method === "Runtime.callFunctionOn" && eventDispatchError) {
        throw eventDispatchError;
      }
      return {};
    },
  );
});

it("resolves a snapshot uid through the Map registry on the exact tab", async () => {
  await expect(
    chromeInputUpload({
      tab: resolvedTabFixture(),
      foreground: false,
      uid: "el-file",
      paths: ["/tmp/upload.txt"],
    }),
  ).resolves.toEqual({
    input: "chrome",
    uploaded: [{ path: "/tmp/upload.txt" }],
  });

  expect(fileInput.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(inputMocks.cdp.mock.calls.every(([tabId]) => tabId === 7)).toBe(true);
  expect(inputMocks.cdp).toHaveBeenCalledWith(7, "DOM.setFileInputFiles", {
    nodeId: 17,
    files: ["/tmp/upload.txt"],
  });
});

it("fails after event dispatch rejection and still releases the remote object", async () => {
  eventDispatchError = new Error("event dispatch failed");

  await expect(
    chromeInputUpload({
      tab: resolvedTabFixture(),
      foreground: false,
      uid: "el-file",
      paths: ["/tmp/upload.txt"],
    }),
  ).rejects.toThrow("event dispatch failed");

  expect(inputMocks.cdp.mock.calls.map(([, method]) => method)).toEqual([
    "Runtime.evaluate",
    "DOM.enable",
    "DOM.requestNode",
    "DOM.setFileInputFiles",
    "Runtime.callFunctionOn",
    "Runtime.releaseObject",
  ]);
  expect(inputMocks.cdp).toHaveBeenLastCalledWith(7, "Runtime.releaseObject", {
    objectId: "file-input-object",
  });
});
