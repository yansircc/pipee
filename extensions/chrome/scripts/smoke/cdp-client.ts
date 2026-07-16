import assert from "node:assert/strict";
import type { ConnectorRouteIdentity, ProfileConnector } from "../../src/protocol/schema.js";
import type { FakeBridge } from "./fake-bridge.ts";
import type { LaunchedChrome } from "./chrome-process.ts";
import { decodeProfileConnector } from "./protocol-fixture.ts";
import { deferred, SmokeFailure, waitForCondition, withTimeout, type Deferred } from "./support.ts";

type JsonObject = Readonly<Record<string, unknown>>;

type CdpEvent = {
  readonly method: string;
  readonly params: unknown;
};

type CdpWaiter = {
  readonly method: string;
  readonly predicate: (params: unknown) => boolean;
  readonly result: Deferred<unknown>;
};

type CdpPending = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
};

export type CdpClient = {
  readonly close: () => void;
  readonly send: <Result = JsonObject>(
    method: string,
    params?: JsonObject,
    sessionId?: string,
  ) => Promise<Result>;
  readonly waitForEvent: <Params>(
    method: string,
    predicate: (params: Params) => boolean,
    label: string,
    timeoutMs?: number,
  ) => Promise<Params>;
};

const asRecord = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeFailure(`${label} is not an object`);
  }
  return value as JsonObject;
};

const openCdp = (url: string): Promise<CdpClient> =>
  new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(url);
    const pending = new Map<number, CdpPending>();
    const events: Array<CdpEvent> = [];
    const eventWaiters = new Set<CdpWaiter>();
    let nextId = 1;
    const send = <Result = JsonObject>(
      method: string,
      params: JsonObject = {},
      sessionId?: string,
    ): Promise<Result> =>
      new Promise((resolveCommand, rejectCommand) => {
        const id = nextId++;
        pending.set(id, {
          resolve: (value) => resolveCommand(value as Result),
          reject: rejectCommand,
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const waitForEvent = <Params>(
      method: string,
      predicate: (params: Params) => boolean,
      label: string,
      timeoutMs: number = 10_000,
    ): Promise<Params> => {
      const eventIndex = events.findIndex(
        (event) => event.method === method && predicate(event.params as Params),
      );
      if (eventIndex >= 0) {
        const [event] = events.splice(eventIndex, 1);
        return Promise.resolve(event!.params as Params);
      }
      const result = deferred<unknown>();
      const registration: CdpWaiter = {
        method,
        predicate: (params) => predicate(params as Params),
        result,
      };
      eventWaiters.add(registration);
      return withTimeout(result.promise as Promise<Params>, label, timeoutMs).finally(() => {
        eventWaiters.delete(registration);
      });
    };
    socket.addEventListener("open", () =>
      resolveOpen({ close: () => socket.close(), send, waitForEvent }),
    );
    socket.addEventListener("message", (event) => {
      const message = asRecord(JSON.parse(String(event.data)), "CDP message");
      if (typeof message.id !== "number") {
        if (typeof message.method !== "string") return;
        const cdpEvent = { method: message.method, params: message.params };
        for (const waiter of eventWaiters) {
          if (cdpEvent.method !== waiter.method || !waiter.predicate(cdpEvent.params)) continue;
          eventWaiters.delete(waiter);
          waiter.result.resolve(cdpEvent.params);
          return;
        }
        events.push(cdpEvent);
        return;
      }
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      const error = message.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        command.reject(new SmokeFailure(`CDP ${String(error.message)}`));
      } else {
        command.resolve(message.result);
      }
    });
    socket.addEventListener("error", () => rejectOpen(new SmokeFailure("CDP socket failed")));
    socket.addEventListener("close", () => {
      for (const command of pending.values()) {
        command.reject(new SmokeFailure("CDP socket closed before command completion"));
      }
      pending.clear();
      for (const waiter of eventWaiters) {
        waiter.result.reject(new SmokeFailure("CDP socket closed before event delivery"));
      }
      eventWaiters.clear();
    });
  });

type TargetInfo = {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
};

type RuntimeEvaluation = {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: { readonly text?: string };
};

export const drivePairingPopup = async (
  chrome: LaunchedChrome,
  popupUrl: string,
  pairingCapability: string,
): Promise<void> => {
  const webSocketUrl = await withTimeout(chrome.devToolsReady, "Chrome DevTools endpoint", 10_000);
  const cdp = await openCdp(webSocketUrl);
  try {
    const { targetId } = await cdp.send<{ readonly targetId: string }>("Target.createTarget", {
      url: popupUrl,
    });
    const { sessionId } = await cdp.send<{ readonly sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await waitForCondition(async () => {
      const evaluation = await cdp.send<RuntimeEvaluation>(
        "Runtime.evaluate",
        {
          expression:
            "document.readyState === 'complete' && !!document.querySelector('#challenge') && !document.querySelector('#confirm').disabled",
          returnByValue: true,
        },
        sessionId,
      );
      return evaluation.result?.value === true;
    }, "pairing popup to become interactive");
    const expression = `(() => {
      const label = document.querySelector('#label');
      const challenge = document.querySelector('#challenge');
      const confirm = document.querySelector('#confirm');
      label.value = ${JSON.stringify("日常 Chrome Smoke")};
      challenge.value = ${JSON.stringify(pairingCapability)};
      confirm.click();
      return true;
    })()`;
    await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    const outcome = await waitForCondition(async () => {
      const evaluation = await cdp.send<RuntimeEvaluation>(
        "Runtime.evaluate",
        {
          expression:
            "(() => { const message = document.querySelector('#message'); const panel = document.querySelector('#challenge-panel'); return { level: message?.dataset?.level ?? '', text: message?.textContent ?? '', hidden: !!panel?.hidden }; })()",
          returnByValue: true,
        },
        sessionId,
      );
      const value = evaluation.result?.value;
      if (typeof value !== "object" || value === null) return false;
      const record = value as JsonObject;
      return record.hidden === true || record.level === "error" ? record : false;
    }, "pairing popup result");
    if (outcome.level === "error") {
      throw new SmokeFailure(`Pairing popup rejected the bridge: ${String(outcome.text)}`);
    }
  } finally {
    cdp.close();
  }
};

const extensionWorkerTargets = async (
  cdp: CdpClient,
  workerUrl: string,
): Promise<Array<TargetInfo>> => {
  const { targetInfos } = await cdp.send<{ readonly targetInfos: ReadonlyArray<TargetInfo> }>(
    "Target.getTargets",
  );
  return targetInfos.filter(
    (target) => target.type === "service_worker" && target.url === workerUrl,
  );
};

export const waitForBrowserEvent = async <Value>(
  bridge: FakeBridge,
  chrome: LaunchedChrome,
  promise: Promise<Value>,
  label: string,
  timeoutMs: number = 30_000,
): Promise<Value> => {
  const outcome = await bridge.waitFor(
    Promise.race([
      promise.then((value) => ({ type: "value" as const, value })),
      chrome.exited.then((exit) => ({ type: "exit" as const, exit })),
    ]),
    label,
    timeoutMs,
  );
  if (outcome.type === "exit") {
    throw new SmokeFailure(
      `Chrome exited before ${label}: ${JSON.stringify(outcome.exit)}\n${chrome.output()}`,
    );
  }
  return outcome.value;
};

type WorkerRestart = {
  readonly initialTargetId: string;
  readonly restartedTargetId: string;
  readonly workerIdentity: ProfileConnector;
  readonly bridgeIdentity: ConnectorRouteIdentity;
};

export const restartExtensionWorker = async (
  bridge: FakeBridge,
  chrome: LaunchedChrome,
  popupUrl: string,
  workerUrl: string,
): Promise<WorkerRestart> => {
  const webSocketUrl = await withTimeout(chrome.devToolsReady, "Chrome DevTools endpoint", 10_000);
  const cdp = await openCdp(webSocketUrl);
  let wakeTargetId: string | undefined;
  try {
    const initialTargets = await extensionWorkerTargets(cdp, workerUrl);
    assert.equal(
      initialTargets.length,
      1,
      `Expected exactly one running extension service worker, saw ${JSON.stringify(initialTargets)}`,
    );
    const initialTargetId = initialTargets[0]!.targetId;

    await cdp.send("Target.closeTarget", { targetId: initialTargetId });
    await waitForCondition(
      async () => (await extensionWorkerTargets(cdp, workerUrl)).length === 0,
      "the original MV3 service worker to stop",
    );

    bridge.expectWorkerRestartIdentity();
    ({ targetId: wakeTargetId } = await cdp.send<{ readonly targetId: string }>(
      "Target.createTarget",
      { url: popupUrl },
    ));
    const { sessionId } = await cdp.send<{ readonly sessionId: string }>("Target.attachToTarget", {
      targetId: wakeTargetId,
      flatten: true,
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await waitForCondition(async () => {
      const readiness = await cdp.send<RuntimeEvaluation>(
        "Runtime.evaluate",
        {
          expression: "typeof chrome?.runtime?.sendMessage === 'function'",
          returnByValue: true,
        },
        sessionId,
      );
      return readiness.result?.value === true;
    }, "extension popup runtime after worker stop");
    const identityResponse = await cdp.send<RuntimeEvaluation>(
      "Runtime.evaluate",
      {
        expression:
          "chrome.runtime.sendMessage({type:'pi-chrome/connector/load'}).then(value => value)",
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (identityResponse.exceptionDetails) {
      throw new SmokeFailure(
        `Worker wake message failed: ${identityResponse.exceptionDetails.text ?? "unknown exception"}`,
      );
    }
    const identityEnvelope = asRecord(identityResponse.result?.value, "worker identity response");
    assert.equal(identityEnvelope.ok, true, JSON.stringify(identityEnvelope));
    const workerIdentity = decodeProfileConnector(identityEnvelope.connector);

    const restartedTarget = await waitForCondition(async () => {
      const targets = await extensionWorkerTargets(cdp, workerUrl);
      return targets.find((target) => target.targetId !== initialTargetId);
    }, "a new MV3 service-worker target");
    const bridgeIdentity = await waitForBrowserEvent(
      bridge,
      chrome,
      bridge.restartIdentityReady.promise,
      "the restarted worker connector poll",
      15_000,
    );
    return {
      initialTargetId,
      restartedTargetId: restartedTarget.targetId,
      workerIdentity,
      bridgeIdentity,
    };
  } finally {
    if (wakeTargetId) {
      await cdp.send("Target.closeTarget", { targetId: wakeTargetId }).catch(() => undefined);
    }
    cdp.close();
  }
};
