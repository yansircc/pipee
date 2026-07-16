import { TextDecoder, TextEncoder } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { installPiChromeInstrumentation } from "../../src/browser/injected/action-instrumentation.js";
import { REQUEST_BODY_BYTE_LIMIT } from "../../src/protocol/bridge-contract.js";

const CONSOLE_METHODS = ["debug", "log", "info", "warn", "error"] as const;

type PageConsole = Pick<Console, (typeof CONSOLE_METHODS)[number]>;

type TestWindow = {
  __PI_CHROME_STATE__?: PiChromePageState;
  fetch?: typeof fetch | undefined;
  XMLHttpRequest?: typeof XMLHttpRequest | undefined;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
};

type TestPage = {
  readonly window: TestWindow;
  readonly console: PageConsole;
  readonly location: { readonly href: string };
  readonly context: Record<string, unknown>;
};

const makePage = (originalFetch?: typeof fetch): TestPage => {
  const pageConsole = Object.fromEntries(
    CONSOLE_METHODS.map((method) => [method, () => undefined]),
  ) as PageConsole;
  const pageWindow: TestWindow = {
    fetch: originalFetch,
    XMLHttpRequest: undefined,
    addEventListener: () => undefined,
  };
  const location = { href: "https://instrumentation.test/page" };
  return {
    window: pageWindow,
    console: pageConsole,
    location,
    context: {
      window: pageWindow,
      console: pageConsole,
      location,
      URL,
      Request: class TestRequest {},
      XMLHttpRequest: undefined,
      TextDecoder,
    },
  };
};

const installSerialized = (page: TestPage): void => {
  runInNewContext(`(${installPiChromeInstrumentation.toString()})()`, page.context);
};

const consoleProjection = (page: TestPage) =>
  page.window.__PI_CHROME_STATE__?.console.map(({ level, url, args }) => ({ level, url, args }));

const responseWithLargeBody = (): Response => {
  const bytes = new TextEncoder().encode("b".repeat(40_000));
  const headers = {
    *entries(): IterableIterator<[string, string]> {
      for (let index = 0; index < 40; index += 1) {
        yield [`header-${index}`, "v".repeat(1_000)];
      }
    },
  };
  return {
    status: 200,
    statusText: "ok",
    ok: true,
    url: `https://response.test/${"r".repeat(3_000)}`,
    headers,
    clone: () => {
      let delivered = false;
      return {
        body: {
          getReader: () => ({
            read: async () => {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
        },
      };
    },
  } as unknown as Response;
};

afterEach(() => vi.unstubAllGlobals());

it("runs the same self-contained installer directly and from navigation source", () => {
  const direct = makePage();
  vi.stubGlobal("window", direct.window);
  vi.stubGlobal("console", direct.console);
  vi.stubGlobal("location", direct.location);
  installPiChromeInstrumentation();
  installPiChromeInstrumentation();

  const directCircular: Record<string, unknown> = { value: "x".repeat(10_000) };
  directCircular.self = directCircular;
  direct.console.warn("message", directCircular);

  const serialized = makePage();
  installSerialized(serialized);
  installSerialized(serialized);
  const serializedCircular: Record<string, unknown> = { value: "x".repeat(10_000) };
  serializedCircular.self = serializedCircular;
  serialized.console.warn("message", serializedCircular);

  expect(consoleProjection(direct)).toEqual(consoleProjection(serialized));
  expect(consoleProjection(direct)).toHaveLength(1);
  expect(direct.window.__PI_CHROME_STATE__?.instrumentationInstalled).toBe(true);
  const source = installPiChromeInstrumentation.toString();
  expect(source).not.toContain("getPiChromeState");
  expect(source).not.toContain("installEarlyCapture");
});

it("bounds console and network caches below one quarter of the wire budget", async () => {
  const originalFetch = (async () => responseWithLargeBody()) as typeof fetch;
  const page = makePage(originalFetch);
  installSerialized(page);

  await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      page.window.fetch!(`https://request.test/${"u".repeat(3_000)}?index=${index}`),
    ),
  );
  const state = page.window.__PI_CHROME_STATE__!;
  await vi.waitFor(() => {
    expect(state.network.every((entry) => entry.responseBody !== undefined)).toBe(true);
  });

  const consoleArguments = Array.from({ length: 20 }, () =>
    Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`key-${index}`, "c".repeat(10_000)]),
    ),
  );
  for (let index = 0; index < 120; index += 1) {
    page.console.error(...consoleArguments);
  }

  expect(state.console).toHaveLength(80);
  expect(state.console.every((entry) => entry.args.length <= 8)).toBe(true);
  expect(
    state.console.every((entry) =>
      entry.args.every((argument) => typeof argument === "string" && argument.length <= 512),
    ),
  ).toBe(true);
  expect(state.network).toHaveLength(40);
  for (const entry of state.network) {
    expect(entry.url.length).toBeLessThanOrEqual(1_024);
    expect(entry.responseUrl?.length).toBeLessThanOrEqual(1_024);
    expect(entry.responseHeaders).toHaveLength(24);
    expect(
      entry.responseHeaders?.every(([name, value]) => name.length <= 64 && value.length <= 256),
    ).toBe(true);
    expect(entry.responseBody).toHaveLength(8_000);
    expect(entry.responseBodyTruncated).toBe(true);
  }

  const cachedBytes = new TextEncoder().encode(
    JSON.stringify({ console: state.console, network: state.network }),
  ).byteLength;
  expect(cachedBytes).toBeLessThan(REQUEST_BODY_BYTE_LIMIT / 4);
});
