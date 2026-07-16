import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRIDGE_HOST, BRIDGE_PORT } from "./protocol-fixture.ts";
import { deferred, REPOSITORY_ROOT, SmokeFailure, SmokeSkip, withTimeout } from "./support.ts";

export type ChromeExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type LaunchedChrome = {
  readonly child: ChildProcess;
  readonly devToolsReady: Promise<string>;
  readonly executable: string;
  readonly exited: Promise<ChromeExit>;
  readonly output: () => string;
};

const BRANDED_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const runProcess = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  label: string,
): Promise<string> =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-24_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveProcess(output);
      else {
        rejectProcess(
          new SmokeFailure(
            `${label} exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}\n${output}`,
          ),
        );
      }
    });
  });

export const buildSmokeExtension = async (
  bridgeUrl: string,
  extensionDirectory: string,
): Promise<void> => {
  await runProcess(
    process.execPath,
    ["scripts/build.ts", "--bridge-url", bridgeUrl, "--out-dir", extensionDirectory],
    "temporary extension build",
  );
};

export const assertNoProductionOrigin = async (directory: string): Promise<void> => {
  const needle = Buffer.from(`http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        assert.equal(
          contents.includes(needle),
          false,
          `${path} contains production bridge origin http://${BRIDGE_HOST}:${BRIDGE_PORT}`,
        );
      }
    }
  };
  await visit(directory);
};

const playwrightChromeForTesting = async (): Promise<string | undefined> => {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  let entries;
  try {
    entries = await readdir(cache, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const installations = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const installation of installations) {
    for (const architecture of ["chrome-mac-arm64", "chrome-mac"]) {
      const candidate = join(
        cache,
        installation,
        architecture,
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
};

const selectChrome = async (): Promise<string> => {
  const override = process.env.PI_CHROME_SMOKE_CHROME;
  if (override) {
    if (!(await exists(override))) {
      throw new SmokeFailure(`PI_CHROME_SMOKE_CHROME does not exist: ${override}`);
    }
    if (resolve(override) === resolve(BRANDED_CHROME_PATH)) {
      throw new SmokeFailure(
        "Branded Google Chrome 137+ rejects --load-extension; point PI_CHROME_SMOKE_CHROME to Chrome for Testing or Chromium",
      );
    }
    return override;
  }

  if (process.platform !== "darwin") {
    throw new SmokeSkip(
      "connector smoke requires PI_CHROME_SMOKE_CHROME outside macOS because browser discovery is platform-specific",
    );
  }

  const installedCandidates = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    await playwrightChromeForTesting(),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of installedCandidates) {
    if (await exists(candidate)) return candidate;
  }

  if (await exists(BRANDED_CHROME_PATH)) {
    throw new SmokeFailure(
      "Only branded Google Chrome is installed, and Chrome 137+ rejects --load-extension. Install Chrome for Testing or Chromium, or set PI_CHROME_SMOKE_CHROME.",
    );
  }
  throw new SmokeFailure(
    "Chrome for Testing or Chromium is required; no supported browser executable was found",
  );
};

export const launchChrome = async (
  extensionDirectory: string,
  userDataDirectory: string,
  initialUrl: string,
): Promise<LaunchedChrome> => {
  const executable = await selectChrome();
  const sandboxArguments = process.env.PI_CHROME_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
  const child = spawn(
    executable,
    [
      ...sandboxArguments,
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDirectory}`,
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-breakpad",
      "--use-mock-keychain",
      "--enable-logging=stderr",
      "--v=0",
      "--window-size=1280,800",
      initialUrl,
    ],
    { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const devToolsReady = deferred<string>();
  const collect = (chunk: Buffer | string): void => {
    output = `${output}${String(chunk)}`.slice(-24_000);
    const webSocketUrl = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    if (webSocketUrl) devToolsReady.resolve(webSocketUrl);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise<ChromeExit>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child,
    devToolsReady: devToolsReady.promise,
    executable,
    exited,
    output: () => output,
  };
};

export const terminateChrome = async (chrome: LaunchedChrome | undefined): Promise<void> => {
  if (!chrome || chrome.child.exitCode !== null || chrome.child.signalCode !== null) return;
  chrome.child.kill("SIGTERM");
  try {
    await withTimeout(chrome.exited, "Chrome to stop", 5_000);
  } catch {
    chrome.child.kill("SIGKILL");
    await chrome.exited;
  }
};
