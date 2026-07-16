import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  Browser,
  BrowserTag,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import crossSpawn from "cross-spawn";

const platform = detectBrowserPlatform();
assert.ok(platform, `Chrome for Testing does not support ${process.platform}/${process.arch}`);
const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
const installed = await install({
  browser: Browser.CHROME,
  buildId,
  cacheDir: resolve(process.env.RUNNER_TEMP ?? tmpdir(), "pi-chrome-cft"),
  platform,
  downloadProgressCallback: "default",
});

const result = crossSpawn.sync("pnpm", ["exec", "vp", "run", "smoke:connector:release"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    PI_CHROME_SMOKE_CHROME: installed.executablePath,
    PI_CHROME_SMOKE_NO_SANDBOX: "1",
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
