import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectorRouteIdentity, ProfileConnector } from "../src/protocol/schema.js";
import { EXTENSION_BUILD_GRAPH } from "./extension-build-graph.ts";
import { exerciseAuthenticationAttacks } from "./smoke/authentication-attacks.ts";
import {
  drivePairingPopup,
  restartExtensionWorker,
  waitForBrowserEvent,
} from "./smoke/cdp-client.ts";
import {
  assertNoProductionOrigin,
  buildSmokeExtension,
  launchChrome,
  terminateChrome,
  type LaunchedChrome,
} from "./smoke/chrome-process.ts";
import { FakeBridge, type BoundSmokeConnector } from "./smoke/fake-bridge.ts";
import { EXTENSION_PUBLIC_KEY, extensionIdFromManifestKey } from "./smoke/protocol-fixture.ts";
import { pageCommands, VERSION_COMMAND } from "./smoke/scenario-fixture.ts";
import { REPOSITORY_ROOT, SmokeFailure, SmokeSkip } from "./smoke/support.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const asObject = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeFailure(`${label} must be an object`);
  }
  return value as JsonObject;
};

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const readPackageVersion = async (): Promise<string> => {
  const manifest = asObject(await readJson(join(REPOSITORY_ROOT, "package.json")), "package.json");
  if (typeof manifest.version !== "string") throw new SmokeFailure("package version is missing");
  return manifest.version;
};

const assertStableConnectorIdentity = (
  expected: BoundSmokeConnector,
  actual: ProfileConnector,
  source: string,
): void => {
  for (const field of [
    "connectorId",
    "secret",
    "extensionId",
    "extensionDisplayVersion",
    "protocolFingerprint",
  ] as const) {
    assert.equal(actual[field], expected[field], `${source} changed connector ${field}`);
  }
};

const assertStablePublicIdentity = (
  expected: BoundSmokeConnector,
  actual: ConnectorRouteIdentity,
  source: string,
): void => {
  for (const field of [
    "connectorId",
    "extensionId",
    "extensionDisplayVersion",
    "protocolFingerprint",
  ] as const) {
    assert.equal(actual[field], expected[field], `${source} changed connector ${field}`);
  }
};

const smokeOptions = (): { readonly requireBrowser: boolean; readonly noSandbox: boolean } => {
  const arguments_ = new Set(process.argv.slice(2));
  for (const argument of arguments_) {
    if (argument !== "--require-browser" && argument !== "--no-sandbox")
      throw new SmokeFailure(`Unknown smoke option: ${argument}`);
  }
  return {
    requireBrowser: arguments_.has("--require-browser"),
    noSandbox: arguments_.has("--no-sandbox"),
  };
};

const runSmoke = async (): Promise<void> => {
  const packageVersion = await readPackageVersion();
  const expectedExtensionId = extensionIdFromManifestKey(EXTENSION_PUBLIC_KEY);
  const bridge = new FakeBridge(expectedExtensionId, packageVersion);
  let temporaryDirectory: string | undefined;
  let chrome: LaunchedChrome | undefined;
  const failures: Array<unknown> = [];

  try {
    await bridge.listen();
    const commands = [VERSION_COMMAND, ...pageCommands(`${bridge.url}/smoke-page`)];
    bridge.setCommands(commands);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-chrome-connector-smoke-"));
    const extensionDirectory = join(temporaryDirectory, "extension");
    const userDataDirectory = join(temporaryDirectory, "chrome-profile");
    assert.notEqual(
      resolve(extensionDirectory),
      resolve(REPOSITORY_ROOT, "dist/browser-extension"),
    );

    await buildSmokeExtension(bridge.url, extensionDirectory);
    const manifest = asObject(
      await readJson(join(extensionDirectory, "manifest.json")),
      "built extension manifest",
    );
    assert.equal(manifest.key, EXTENSION_PUBLIC_KEY);
    assert.equal(manifest.version, packageVersion);
    assert.equal(
      manifest.minimum_chrome_version,
      String(EXTENSION_BUILD_GRAPH.minimumChromeVersion),
    );
    assert.deepEqual(manifest.permissions, [
      "tabs",
      "tabGroups",
      "scripting",
      "storage",
      "unlimitedStorage",
      "alarms",
      "debugger",
    ]);
    await assertNoProductionOrigin(extensionDirectory);

    chrome = await launchChrome(extensionDirectory, userDataDirectory, "about:blank");
    await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.unpairedReady.promise,
      "two stable unpaired connector handshakes",
      15_000,
    );
    const action = asObject(manifest.action, "extension action");
    const background = asObject(manifest.background, "extension background");
    assert.equal(typeof action.default_popup, "string");
    assert.equal(typeof background.service_worker, "string");
    const popupUrl = `chrome-extension://${expectedExtensionId}/${String(action.default_popup)}`;
    const workerUrl = `chrome-extension://${expectedExtensionId}/${String(background.service_worker)}`;
    await drivePairingPopup(chrome, popupUrl, bridge.pairingCapability);
    await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.pairingReady.promise,
      "popup HMAC pairing confirmation",
      15_000,
    );
    const identity = await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.identityReady.promise,
      "the temporary profile connector",
      15_000,
    );
    assert(
      identity.transportOrigin === undefined || identity.transportOrigin === identity.runtimeOrigin,
      `Chrome host-permission fetch used an unexpected HTTP Origin: ${String(identity.transportOrigin)}`,
    );
    assert.equal(identity.runtimeOrigin, `chrome-extension://${expectedExtensionId}`);
    assert.equal(identity.extensionId, expectedExtensionId);
    assert.equal(identity.extensionDisplayVersion, packageVersion);
    assert.equal(identity.protocolFingerprint, bridge.expectedProtocolFingerprint);

    const restarted = await restartExtensionWorker(bridge, chrome, popupUrl, workerUrl);
    assert.notEqual(
      restarted.restartedTargetId,
      restarted.initialTargetId,
      "MV3 worker restart reused the original target id",
    );
    assertStableConnectorIdentity(
      identity,
      restarted.workerIdentity,
      "worker message after restart",
    );
    assertStablePublicIdentity(
      identity,
      restarted.bridgeIdentity,
      "bridge handshake after restart",
    );

    await exerciseAuthenticationAttacks(bridge, identity, chrome);
    bridge.armFingerprintMismatch();
    await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.fingerprintMismatchReady.promise,
      "fingerprint mismatch rejection before command delivery",
      15_000,
    );
    assert.equal(bridge.incompatibleResultAttempts, 0);
    assert.equal(bridge.commandDeliveryReleased, false);
    assert.equal(bridge.nextCommandIndex, 0);
    assert.equal(bridge.currentCommand, undefined);
    assert.deepEqual(bridge.results, []);

    bridge.releaseCommandDelivery();
    await waitForBrowserEvent(bridge, chrome, bridge.commandReady.promise, "command delivery");
    bridge.releaseResultDelivery();
    const result = await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.resultReady.promise,
      "the authenticated command result",
    );
    assert.equal(result.id, VERSION_COMMAND.id);
    assert.equal(
      bridge.resultAttempts.get(VERSION_COMMAND.id),
      2,
      "Durable result was not retried with a fresh proof after HTTP 401",
    );
    await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.pollAfterAcknowledgement.promise,
      "the first poll after terminal result acknowledgement",
    );
    const results = await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.allResultsReady.promise,
      "the real-profile navigation and snapshot results",
    );
    const navigation = results.find(({ id }) => id === commands[1]!.id);
    const secondTab = results.find(({ id }) => id === commands[2]!.id);
    const wait = results.find(({ id }) => id === commands[3]!.id);
    const secondSnapshot = results.find(({ id }) => id === commands[4]!.id);
    const firstSnapshot = results.find(({ id }) => id === commands[5]!.id);
    const click = results.find(({ id }) => id === commands[6]!.id);
    const firstRead = results.find(({ id }) => id === commands[7]!.id);
    const cleanup = results.find(({ id }) => id === commands[8]!.id);
    assert(navigation, "Navigation result is missing");
    assert(secondTab, "Second owned-tab result is missing");
    assert(wait, "Typed wait result is missing");
    assert(secondSnapshot, "Second text snapshot result is missing");
    assert(firstSnapshot, "First text snapshot result is missing");
    assert(click, "Input result with post-action verification is missing");
    assert(firstRead, "First rendered-content result is missing");
    assert(cleanup, "Session cleanup result is missing");
    const navigationValue = asObject(navigation.value, "navigation result");
    const navigationTab = asObject(navigationValue.tab, "navigation tab");
    const navigationSnapshot = asObject(navigationValue.snapshot, "navigation snapshot");
    const secondTabValue = asObject(secondTab.value, "second owned tab");
    const waitValue = asObject(wait.value, "typed wait result");
    const secondSnapshotValue = asObject(secondSnapshot.value, "second snapshot result");
    const firstSnapshotValue = asObject(firstSnapshot.value, "first snapshot result");
    const clickValue = asObject(click.value, "click result");
    const clickAction = asObject(clickValue.action, "click action receipt");
    const clickVerification = asObject(clickValue.verification, "click verification");
    const firstReadValue = asObject(firstRead.value, "first read result");
    const cleanupValue = asObject(cleanup.value, "cleanup result");
    assert.equal(navigationTab.url, `${bridge.url}/smoke-page?source=first`);
    assert.equal(navigationSnapshot.title, "Pi Chrome Smoke First");
    assert.equal(secondSnapshotValue.title, "Pi Chrome Smoke Second");
    assert.equal(firstSnapshotValue.title, "Pi Chrome Smoke First");
    assert.equal(clickAction.input, "chrome");
    assert.equal(clickVerification.status, "observed");
    assert.equal(
      asObject(clickVerification.snapshot, "click verification snapshot").title,
      "Pi Chrome Smoke First",
    );
    assert.notEqual(navigationTab.id, secondTabValue.id, "Owned source tabs reused one tab id");
    assert.equal(waitValue.satisfied, true);
    for (const [snapshot, code, href] of [
      [navigationSnapshot, "ALPHA-SMOKE", "https://first.example.test/report"],
      [secondSnapshotValue, "BETA-SMOKE", "https://second.example.test/report"],
      [firstSnapshotValue, "ALPHA-SMOKE", "https://first.example.test/report"],
    ] as const) {
      const blocks = snapshot.contentBlocks;
      assert(Array.isArray(blocks), "Text snapshot did not return content blocks");
      const serialized = JSON.stringify(blocks);
      assert(
        serialized.includes(code) && serialized.includes(href),
        `Text snapshot omitted semantic content for ${code}`,
      );
      assert.equal(
        Object.hasOwn(snapshot, "elements") || Object.hasOwn(snapshot, "textSnippets"),
        false,
        "Text snapshot leaked a parallel reading projection",
      );
    }
    assert(Array.isArray(firstReadValue.blocks), "chrome_read did not return content blocks");
    assert(
      JSON.stringify(firstReadValue.blocks).includes("ALPHA-SMOKE"),
      "chrome_read omitted rendered content from the exact first tab",
    );
    assert.equal(
      Object.hasOwn(firstReadValue, "actions"),
      false,
      "chrome_read loaded the Action Graph",
    );
    assert.deepEqual(
      cleanupValue.closedTabIds,
      [navigationTab.id, secondTabValue.id],
      "Session cleanup did not close the exact owned target set",
    );

    console.log(
      `PASS connector smoke: ${identity.connectorId.slice(0, 8)} @ ${identity.runtimeOrigin} via ${bridge.url}\nBrowser: ${chrome.executable}`,
    );
  } catch (cause) {
    if (cause instanceof SmokeSkip) failures.push(cause);
    else {
      const message = cause instanceof Error ? cause.message : String(cause);
      const chromeOutput = chrome?.output().trim();
      const scenarioState = JSON.stringify({
        nextCommandIndex: bridge.nextCommandIndex,
        currentCommandId: bridge.currentCommand?.id ?? null,
        completedResultIds: bridge.results.map(({ id }) => id),
      });
      failures.push(
        new SmokeFailure(
          `${message}\n\nScenario: ${scenarioState}${chromeOutput ? `\n\nChrome output:\n${chromeOutput}` : ""}`,
          { cause },
        ),
      );
    }
  }

  for (const cleanup of [
    () => terminateChrome(chrome),
    () => bridge.close(),
    () =>
      temporaryDirectory
        ? rm(temporaryDirectory, { recursive: true, force: true })
        : Promise.resolve(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Connector smoke failed and cleanup also failed");
  }
  if (failures.length === 1) throw failures[0];
};

const options = smokeOptions();
if (options.noSandbox) process.env.PI_CHROME_SMOKE_NO_SANDBOX = "1";
try {
  await runSmoke();
} catch (error) {
  if (error instanceof SmokeSkip && !options.requireBrowser) {
    console.log(`SKIP connector smoke: ${error.message}`);
  } else {
    const failure =
      error instanceof SmokeSkip
        ? new SmokeFailure(`Required browser is unavailable: ${error.message}`, { cause: error })
        : error;
    console.error(failure instanceof Error ? `${failure.name}: ${failure.message}` : failure);
    process.exitCode = 1;
  }
}
