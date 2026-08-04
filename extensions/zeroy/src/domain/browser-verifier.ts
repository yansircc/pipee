import { spawn, type ChildProcess } from "node:child_process";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Path, Scope } from "effect";
import { ZeroYConnectorError } from "./client.js";
import type { BrowserEvidence, BrowserVerificationChallenge } from "./protocol.js";

type JsonObject = Readonly<Record<string, unknown>>;
type Resume<Value> = (effect: Effect.Effect<Value, BrowserRuntimeError>) => void;

class BrowserRuntimeError extends Data.TaggedError("BrowserRuntimeError")<{
  readonly message: string;
}> {}

const failure = (message: string) => new BrowserRuntimeError({ message });

const timed = <Value>(effect: Effect.Effect<Value, BrowserRuntimeError>, label: string) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure(`Timed out waiting for ${label}.`)),
    }),
  );

type Pending = {
  readonly resume: Resume<JsonObject>;
};

/**
 * The only platform adapter in the verifier. WebSocket callbacks are converted
 * immediately into interruptible Effects; no Promise or callback lifecycle
 * escapes this class.
 */
class CdpSession {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(params: JsonObject) => void>>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as JsonObject;
      const id = typeof payload.id === "number" ? payload.id : undefined;
      if (id !== undefined) {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        const error = payload.error as JsonObject | undefined;
        const message = error?.message;
        if (error) {
          pending.resume(
            Effect.fail(
              failure(typeof message === "string" ? message : "Chrome DevTools command failed."),
            ),
          );
        } else {
          pending.resume(Effect.succeed((payload.result as JsonObject | undefined) ?? {}));
        }
        return;
      }
      const method = typeof payload.method === "string" ? payload.method : undefined;
      const params = payload.params as JsonObject | undefined;
      if (method && params) {
        for (const listener of this.#listeners.get(method) ?? []) listener(params);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.resume(Effect.fail(failure("Chrome DevTools connection closed.")));
      }
      this.#pending.clear();
    });
  }

  static connect(url: string): Effect.Effect<CdpSession, BrowserRuntimeError, Scope.Scope> {
    const open = timed(
      Effect.callback<CdpSession, BrowserRuntimeError>((resume) => {
        const socket = new WebSocket(url);
        const opened = (): void => {
          cleanup();
          resume(Effect.succeed(new CdpSession(socket)));
        };
        const errored = (): void => {
          cleanup();
          socket.close();
          resume(Effect.fail(failure("Could not open Chrome DevTools WebSocket.")));
        };
        const cleanup = (): void => {
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", errored);
        };
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", errored, { once: true });
        return Effect.sync(() => {
          cleanup();
          socket.close();
        });
      }),
      "Chrome DevTools WebSocket",
    );
    return Effect.acquireRelease(open, (session) => session.close());
  }

  send(method: string, params: JsonObject = {}): Effect.Effect<JsonObject, BrowserRuntimeError> {
    const id = this.#nextId++;
    return timed(
      Effect.callback<JsonObject, BrowserRuntimeError>((resume) => {
        this.#pending.set(id, { resume });
        this.#socket.send(JSON.stringify({ id, method, params }));
        return Effect.sync(() => this.#pending.delete(id));
      }),
      method,
    );
  }

  waitFor(method: string): Effect.Effect<JsonObject, BrowserRuntimeError> {
    return timed(
      Effect.callback<JsonObject, BrowserRuntimeError>((resume) => {
        const listener = (params: JsonObject): void => {
          remove();
          resume(Effect.succeed(params));
        };
        const listeners = this.#listeners.get(method) ?? new Set();
        const remove = (): void => {
          listeners.delete(listener);
          if (listeners.size === 0) this.#listeners.delete(method);
        };
        listeners.add(listener);
        this.#listeners.set(method, listeners);
        return Effect.sync(remove);
      }),
      method,
    );
  }

  on(method: string, listener: (params: JsonObject) => void): () => void {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  close(): Effect.Effect<void> {
    return Effect.sync(() => this.#socket.close());
  }
}

type ChromeProcess = {
  readonly child: ChildProcess;
  readonly browser: CdpSession;
  readonly origin: string;
};

const optionalConfig = (name: string) =>
  Config.string(name).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );

const existing = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));

const playwrightChromium = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  localAppData: string,
) =>
  Effect.gen(function* () {
    const roots =
      process.platform === "darwin"
        ? [path.join(home, "Library", "Caches", "ms-playwright")]
        : process.platform === "win32"
          ? [path.join(localAppData, "ms-playwright")]
          : [path.join(home, ".cache", "ms-playwright")];
    for (const root of roots) {
      const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const installations = entries
        .filter((entry) => entry.startsWith("chromium-"))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const installation of installations) {
        const candidates =
          process.platform === "darwin"
            ? [
                path.join(
                  root,
                  installation,
                  "chrome-mac-arm64",
                  "Google Chrome for Testing.app",
                  "Contents",
                  "MacOS",
                  "Google Chrome for Testing",
                ),
                path.join(
                  root,
                  installation,
                  "chrome-mac",
                  "Google Chrome for Testing.app",
                  "Contents",
                  "MacOS",
                  "Google Chrome for Testing",
                ),
              ]
            : process.platform === "win32"
              ? [
                  path.join(root, installation, "chrome-win64", "chrome.exe"),
                  path.join(root, installation, "chrome-win", "chrome.exe"),
                ]
              : [
                  path.join(root, installation, "chrome-linux64", "chrome"),
                  path.join(root, installation, "chrome-linux", "chrome"),
                ];
        for (const candidate of candidates) {
          if (yield* existing(fileSystem, candidate)) return candidate;
        }
      }
    }
    return undefined;
  });

const browserExecutable = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const override = yield* optionalConfig("ZEROY_BROWSER_EXECUTABLE");
  if (override !== "") {
    if (!(yield* existing(fileSystem, override))) {
      return yield* failure(`ZEROY_BROWSER_EXECUTABLE does not exist: ${override}`);
    }
    return override;
  }
  const home = yield* optionalConfig("HOME");
  const localAppData = yield* optionalConfig("LOCALAPPDATA");
  const programFiles = yield* optionalConfig("PROGRAMFILES");
  const programFilesX86 = yield* optionalConfig("PROGRAMFILES(X86)");
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : process.platform === "win32"
        ? [
            path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  const cached = yield* playwrightChromium(fileSystem, path, home, localAppData);
  for (const candidate of cached === undefined ? candidates : [cached, ...candidates]) {
    if (yield* existing(fileSystem, candidate)) return candidate;
  }
  return yield* failure(
    "No compatible Chromium browser is available. Set ZEROY_BROWSER_EXECUTABLE or install Chrome.",
  );
});

const spawnChrome = (
  executable: string,
  userDataDirectory: string,
): Effect.Effect<
  { readonly child: ChildProcess; readonly browserUrl: string },
  BrowserRuntimeError
> =>
  timed(
    Effect.callback((resume) => {
      const child = spawn(
        executable,
        [
          "--headless=new",
          "--remote-debugging-port=0",
          "--remote-allow-origins=*",
          `--user-data-dir=${userDataDirectory}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-default-apps",
          "--disable-breakpad",
          "--use-mock-keychain",
          "about:blank",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let completed = false;
      const cleanup = (): void => {
        child.stdout?.off("data", collect);
        child.stderr?.off("data", collect);
        child.off("error", errored);
        child.off("exit", exited);
      };
      const finish = (
        effect: Effect.Effect<
          { readonly child: ChildProcess; readonly browserUrl: string },
          BrowserRuntimeError
        >,
      ): void => {
        if (completed) return;
        completed = true;
        cleanup();
        resume(effect);
      };
      const collect = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-24_000);
        const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
        if (found) finish(Effect.succeed({ child, browserUrl: found }));
      };
      const errored = (cause: globalThis.Error): void =>
        finish(Effect.fail(failure(`Chrome failed to launch: ${cause.message}`)));
      const exited = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(
          Effect.fail(
            failure(
              `Chrome exited before DevTools was ready (${String(code ?? signal)}). ${output}`,
            ),
          ),
        );
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", errored);
      child.once("exit", exited);
      return Effect.sync(() => {
        cleanup();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    }),
    "Chrome DevTools endpoint",
  );

const launchChrome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const executable = yield* browserExecutable;
  const userDataDirectory = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "zeroy-browser-" })
    .pipe(
      Effect.mapError((cause) => failure(`Could not create browser profile: ${cause.message}`)),
    );
  const launched = yield* Effect.acquireRelease(
    spawnChrome(executable, userDataDirectory),
    ({ child }) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }),
  );
  const parsed = yield* Effect.try({
    try: () => new URL(launched.browserUrl),
    catch: () => failure("Chrome returned an invalid DevTools endpoint."),
  });
  const browser = yield* CdpSession.connect(launched.browserUrl);
  yield* Effect.addFinalizer(() =>
    browser.send("Browser.close").pipe(
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    ),
  );
  return {
    child: launched.child,
    browser,
    origin: `http://${parsed.host}`,
  } satisfies ChromeProcess;
});

const pageSession = (chrome: ChromeProcess) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(`${chrome.origin}/json/new?about:blank`, { method: "PUT" }),
      catch: (cause) => failure(`Chrome could not create a page target: ${String(cause)}`),
    });
    if (!response.ok) {
      return yield* failure(`Chrome could not create a page target (${response.status}).`);
    }
    const target = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => failure("Chrome returned an invalid page target response."),
    });
    const url =
      typeof target === "object" &&
      target !== null &&
      "webSocketDebuggerUrl" in target &&
      typeof target.webSocketDebuggerUrl === "string"
        ? target.webSocketDebuggerUrl
        : undefined;
    if (!url) return yield* failure("Chrome page target did not expose a DevTools WebSocket.");
    const page = yield* CdpSession.connect(url);
    yield* Effect.all([
      page.send("Page.enable"),
      page.send("Network.enable"),
      page.send("Runtime.enable"),
    ]);
    return page;
  });

const evaluate = <Value>(page: CdpSession, expression: string) =>
  page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).pipe(
    Effect.flatMap((response) => {
      const exception = response.exceptionDetails as JsonObject | undefined;
      if (exception) {
        return Effect.fail(failure(`Browser evaluation failed: ${JSON.stringify(exception)}`));
      }
      const result = response.result as JsonObject | undefined;
      return Effect.succeed(result?.value as Value);
    }),
  );

export const browserMeasurementExpression = (
  challenge: BrowserVerificationChallenge,
): string => `(() => {
  const pairs = ${JSON.stringify(challenge.contrastPairs)};
  const root = getComputedStyle(document.documentElement);
  const durationMs = value => Math.max(0, ...value.split(',').map(part => {
    const item = part.trim(); const number = Number.parseFloat(item);
    if (!Number.isFinite(number)) return 0;
    return item.endsWith('ms') ? number : number * 1000;
  }));
  const colorCanvas = document.createElement('canvas'); colorCanvas.width = 1; colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => {
    if (!colorContext || typeof value !== 'string' || value.trim() === '' || !CSS.supports('color', value)) return null;
    colorContext.clearRect(0, 0, 1, 1); colorContext.fillStyle = value; colorContext.fillRect(0, 0, 1, 1);
    const channels = colorContext.getImageData(0, 0, 1, 1).data;
    return [channels[0], channels[1], channels[2], channels[3] / 255];
  };
  const over = (foreground, background) => {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map(index => (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha).concat(alpha);
  };
  const luminance = color => {
    const channels = color.map(channel => { const normalized = channel / 255; return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrastColors = (foreground, background) => { const left = luminance(foreground); const right = luminance(background); return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05); };
  // The verifier must report a missing or unloaded stylesheet as evidence, not
  // abort the complete Push corridor. A zero pair is rejected by the exact
  // server-side challenge contract and the stylesheet identity check explains
  // the root cause in Review.
  const contrast = (foreground, background) => {
    const left = rgba(foreground); const right = rgba(background);
    return left === null || right === null ? 0 : contrastColors(left, right);
  };
  const viewportWidth = document.documentElement.clientWidth;
  const elements = [...document.querySelectorAll('body *')].filter(element => { const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden'; });
  const describe = element => element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + [...element.classList].slice(0, 3).map(name => '.' + name).join('');
  const directText = element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim() !== '');
  const visibleTextElements = elements.filter(element => {
    if (!directText(element)) return false;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width < 1 || rectangle.height < 1) return false;
    let current = element;
    while (current) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) <= 0.01) return false;
      current = current.parentElement;
    }
    return true;
  });
  const backgroundFor = element => {
    let background = [0, 0, 0, 0];
    let current = element;
    while (current) {
      const style = getComputedStyle(current);
      const color = rgba(style.backgroundColor);
      if (color === null) return { color: background, unresolved: 'background-color' };
      background = over(background, color);
      if (background[3] >= 0.999) return { color: background, unresolved: null };
      if (style.backgroundImage !== 'none') return { color: background, unresolved: 'background-image' };
      current = current.parentElement;
    }
    const rootBackground = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (rootBackground === null) return { color: background, unresolved: 'root-background-color' };
    background = over(background, rootBackground);
    return background[3] >= 0.999
      ? { color: background, unresolved: null }
      : { color: over(background, [255, 255, 255, 1]), unresolved: null };
  };
  const visibleTextContrast = visibleTextElements.map(element => {
    const style = getComputedStyle(element);
    const background = backgroundFor(element);
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
    const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
    let opacity = 1;
    let current = element;
    while (current) {
      opacity *= Number.parseFloat(getComputedStyle(current).opacity) || 0;
      current = current.parentElement;
    }
    const foreground = rgba(style.color);
    if (foreground === null) return { element, ratio: 0, required, unresolved: 'foreground-color' };
    foreground[3] *= opacity;
    const ratio = background.unresolved ? 0 : contrastColors(over(foreground, background.color), background.color);
    return { element, ratio, required, unresolved: background.unresolved };
  });
  // A CSS cascade does not reveal the pixels under a gradient, image, video,
  // or canvas. Never manufacture a ratio of zero for such a region: that
  // would make every legitimate hero image a false blocking failure. Keep the
  // observation for Review, while only a measured color pair can fail Proof.
  const visibleTextContrastFailures = visibleTextContrast.filter(item => !item.unresolved && item.ratio + 0.0001 < item.required);
  const visibleTextContrastIndeterminate = visibleTextContrast.filter(item => item.unresolved);
  const overflowing = elements.filter(element => { const rectangle = element.getBoundingClientRect(); return rectangle.right > viewportWidth + 1 || rectangle.left < -1; });
  const overflowingMedia = [...document.querySelectorAll('img, picture, video, canvas, svg, iframe')].filter(element => { const rectangle = element.getBoundingClientRect(); const parent = element.parentElement && element.parentElement.getBoundingClientRect(); return rectangle.right > viewportWidth + 1 || rectangle.left < -1 || (parent && rectangle.width > parent.width + 1); });
  const motionEscapes = elements.filter(element => { const style = getComputedStyle(element); const animated = style.animationName !== 'none'; const transitioned = durationMs(style.transitionDuration) > 0; return (animated && durationMs(style.animationDuration) > 0.011) || (transitioned && durationMs(style.transitionDuration) > 0.011); });
  const renderedFields = [...document.querySelectorAll('[data-zeroy-field]')].filter(element => {
    const style = getComputedStyle(element); const rectangle = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rectangle.width < 1 || rectangle.height < 1) return false;
    return (element.textContent || '').trim() !== '' || element.querySelector('img[src], video[src], iframe[src], a[href], table, dl, ul, ol') !== null;
  }).map(element => element.getAttribute('data-zeroy-field')).filter(value => typeof value === 'string');
  return {
    stylesheets: [...document.styleSheets].map(stylesheet => stylesheet.href).filter(href => typeof href === 'string'),
    documentClientWidth: viewportWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    overflowElements: overflowing.length,
    overflowSamples: overflowing.slice(0, 5).map(describe),
    mediaOverflowElements: overflowingMedia.length,
    mediaOverflowSamples: overflowingMedia.slice(0, 5).map(describe),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches && motionEscapes.length === 0,
    contrastRatios: Object.fromEntries(pairs.map(pair => [pair.id, contrast(root.getPropertyValue(pair.foreground), root.getPropertyValue(pair.background))])),
    visibleTextContrastFailures: visibleTextContrastFailures.length,
    visibleTextContrastSamples: visibleTextContrastFailures.slice(0, 5).map(item => describe(item.element) + ' contrast=' + item.ratio.toFixed(2) + ', minimum=' + item.required.toFixed(1) + (item.unresolved ? ', unresolved=' + item.unresolved : '')),
    visibleTextContrastIndeterminate: visibleTextContrastIndeterminate.length,
    visibleTextContrastIndeterminateSamples: visibleTextContrastIndeterminate.slice(0, 5).map(item => describe(item.element) + ' unresolved=' + item.unresolved),
    renderedFields: [...new Set(renderedFields)].sort()
  };
})()`;

type Measurements = Omit<
  BrowserEvidence["results"][number],
  "scenario" | "viewport" | "status" | "routeKind" | "stylesheetIdentity" | "focusVisible"
>;

const executeChallenge = (
  chrome: ChromeProcess,
  challenge: BrowserVerificationChallenge,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const browserVersion = yield* chrome.browser.send("Browser.getVersion");
    const page = yield* pageSession(chrome);
    const results: Array<BrowserEvidence["results"][number]> = [];
    for (const viewport of challenge.viewports) {
      yield* page.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      yield* page.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "prefers-color-scheme", value: "light" },
        ],
      });
      for (const scenario of challenge.scenarios) {
        if (signal?.aborted) return yield* failure("Browser verification was aborted.");
        let documentResponse: JsonObject | undefined;
        const removeResponseListener = page.on("Network.responseReceived", (params) => {
          if (params.type === "Document") {
            documentResponse = params.response as JsonObject | undefined;
          }
        });
        const loaded = page.waitFor("Page.loadEventFired");
        const navigation = yield* Effect.gen(function* () {
          const value = yield* page.send("Page.navigate", { url: scenario.url });
          yield* loaded;
          return value;
        }).pipe(Effect.ensuring(Effect.sync(removeResponseListener)));
        if (typeof navigation.errorText === "string" && navigation.errorText !== "") {
          return yield* failure(
            `Browser navigation failed for ${scenario.id}: ${navigation.errorText}`,
          );
        }
        if (!documentResponse) {
          return yield* failure(`Browser emitted no document response for ${scenario.id}.`);
        }
        const measurements = yield* evaluate<Measurements>(
          page,
          browserMeasurementExpression(challenge),
        );
        yield* page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        yield* page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
          nativeVirtualKeyCode: 9,
        });
        const focusVisible = yield* evaluate<boolean | null>(
          page,
          `(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || active === document.body || active === document.documentElement) return null;
          const style = getComputedStyle(active);
          return active.matches(':focus-visible') && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        })()`,
        );
        const headers = (documentResponse.headers as JsonObject | undefined) ?? {};
        const header = (name: string): string => {
          const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
          return key && typeof headers[key] === "string" ? headers[key] : "";
        };
        results.push({
          scenario: scenario.id,
          viewport: viewport.id,
          status: Math.round(Number(documentResponse.status)),
          routeKind: header("x-zeroy-route-kind") || null,
          stylesheetIdentity: header("x-zeroy-stylesheet-identity"),
          ...measurements,
          focusVisible,
        });
      }
    }
    const product = browserVersion.product;
    return {
      contract: "zeroy/browser-evidence@4",
      challengeHash: challenge.challengeHash,
      releaseId: challenge.releaseId,
      themeArtifactId: challenge.themeArtifactId,
      scenarioSetHash: challenge.scenarioSetHash,
      stylesheetSetHash: challenge.stylesheetSetHash,
      verifier: {
        id: "zeroy/pi-browser-verifier@4",
        version: "1",
        engine: "chromium-cdp",
        engineVersion: typeof product === "string" ? product : "unknown",
      },
      results,
    } satisfies BrowserEvidence;
  });

export const verifyBrowserChallengeWithLocalBrowser = (
  challenge: BrowserVerificationChallenge,
  signal?: AbortSignal,
): Effect.Effect<BrowserEvidence, BrowserRuntimeError, NodeServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const chrome = yield* launchChrome;
      return yield* executeChallenge(chrome, challenge, signal);
    }),
  ).pipe(
    Effect.withSpan("zeroy.browser.verify", {
      attributes: { "zeroy.release_id": challenge.releaseId },
    }),
  );

export const verifyBrowserChallenge = (
  challenge: BrowserVerificationChallenge,
  signal: AbortSignal | undefined,
) =>
  verifyBrowserChallengeWithLocalBrowser(challenge, signal).pipe(
    Effect.mapError(
      (cause) =>
        new ZeroYConnectorError({
          code: "zeroy_browser_verification_failed",
          message: cause.message,
        }),
    ),
  );
