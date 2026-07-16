import type { ElementTarget, PointerTarget, Target, WireCommand } from "../protocol/schema.js";
import { COMMAND_DEADLINES_MS } from "../protocol/bridge-contract.js";
import { BrowserOutcomeUnknown, BrowserRejected } from "./browser-command-failure.js";
import {
  getNetworkRequest,
  listConsoleMessages,
  listNetworkRequests,
  probePage,
} from "./injected/actions.js";
import { inputStatus, navigateTab, sleep } from "./platform-cdp.js";
import { chromeInputClick, chromeInputHover } from "./platform-input-click.js";
import {
  chromeInputDrag,
  chromeInputScroll,
  chromeInputTap,
  chromeInputUpload,
} from "./platform-input-pointer.js";
import { chromeInputFill, chromeInputKey, chromeInputType } from "./platform-input-text.js";
import type {
  BrowserInputContext,
  CdpModifierState,
  ElementLocator,
  PointLocator,
} from "./platform-input-types.js";
import {
  evaluateInTab,
  executeInTab,
  inspectInTab,
  navigationInitScriptSource,
  readInTab,
  snapshotInTab,
  takeScreenshot,
  withPostActionVerification,
} from "./platform-page.js";
import {
  bringToFront,
  type BrowserTargetParams,
  cleanupAllAutomationTargets,
  cleanupAutomationTarget,
  createNewAutomationTarget,
  formatTab,
  getAutomationTargetStatus,
  getTabByParams,
  groupTab,
  releaseAutomationTargetTab,
} from "./platform-targets.js";

type CommandFor<Domain extends WireCommand["domain"]> = Extract<
  WireCommand,
  { readonly domain: Domain }
>;

export type BrowserCommandProjection = {
  readonly domain: WireCommand["domain"];
  readonly operation: string;
  readonly effect: "read-only" | "may-mutate";
  readonly params: Readonly<Record<string, unknown>>;
};

type BrowserProgram = BrowserCommandProjection & {
  readonly execute: () => Promise<unknown>;
};

type BrowserCommandContext = BrowserTargetParams & { readonly foreground: boolean };

const browserProgram = <
  const Domain extends WireCommand["domain"],
  const Operation extends string,
  const Params extends Readonly<Record<string, unknown>>,
  Result,
>(
  effect: BrowserCommandProjection["effect"],
  domain: Domain,
  operation: Operation,
  params: Params,
  execute: (params: Params) => Result | Promise<Result>,
): BrowserProgram => ({
  effect,
  domain,
  operation,
  params,
  execute: async () => execute(params),
});

const assertNever = (value: never): never => {
  throw new Error(`Unsupported browser command: ${JSON.stringify(value)}`);
};

const targetParams = (
  target: Target | undefined,
): Pick<BrowserTargetParams, "selectedTabId" | "urlFragment" | "titleFragment"> => {
  if (!target) return {};
  if (target.by === "id") return { selectedTabId: target.value };
  if (target.by === "url") return { urlFragment: target.value };
  return { titleFragment: target.value };
};

const elementParams = (target: ElementTarget | undefined): ElementLocator => {
  if (!target) return {};
  return target.by === "uid" ? { uid: target.value } : { selector: target.value };
};

const pointerParams = (target: PointerTarget): PointLocator =>
  target.by === "coordinate" ? { x: target.x, y: target.y } : elementParams(target);

const commandContext = (
  command: WireCommand,
  target: Target | undefined,
): BrowserCommandContext => ({
  ...targetParams(target),
  sessionKey: command.session.key,
  sessionGroupTitle: command.session.groupTitle,
  foreground: command.session.foreground,
});

const withExactTab = async <Params extends BrowserCommandContext, Result>(
  params: Params,
  execute: (params: Params & BrowserInputContext) => Result | Promise<Result>,
): Promise<Result> => execute({ ...params, tab: await getTabByParams(params) });

type WaitProjection = Readonly<{
  satisfied: boolean;
  observation: Readonly<{
    url: string;
    title: string;
    readyState: "loading" | "interactive" | "complete";
    bodyTextLength: number;
    matchCount?: number;
  }>;
}>;

const waitProjectionExpression = (
  conditionBy: "selector" | "urlIncludes" | "textContains" | "expression",
  conditionValue: string,
): string => {
  const value = JSON.stringify(conditionValue);
  const condition =
    conditionBy === "selector"
      ? `const matchCount=document.querySelectorAll(${value}).length;const satisfied=matchCount>0;`
      : conditionBy === "urlIncludes"
        ? `const satisfied=location.href.includes(${value});`
        : conditionBy === "textContains"
          ? `const satisfied=bodyText.includes(${value});`
          : `const satisfied=Boolean(await (${conditionValue}));`;
  const matchCount = conditionBy === "selector" ? ",matchCount" : "";
  return `(async()=>{const bodyText=document.body?.innerText??"";${condition}return {satisfied,observation:{url:location.href,title:document.title,readyState:document.readyState,bodyTextLength:bodyText.length${matchCount}}}})()`;
};

const interpretTabCommand = (command: CommandFor<"tab">): BrowserProgram => {
  const call = command.call;
  const context = commandContext(command, "target" in call ? call.target : undefined);
  const params = { ...context, call };

  switch (call.op) {
    case "list":
      return browserProgram("read-only", "tab", call.op, params, async () => {
        const tabs = await chrome.tabs.query({});
        return Promise.all(tabs.map(formatTab));
      });
    case "new":
      return browserProgram("may-mutate", "tab", call.op, params, async () => {
        const tab = await createNewAutomationTarget(
          command.session.key,
          command.session.groupTitle,
          call.groupColor,
        );
        if (typeof tab.id !== "number") {
          throw new Error("Chrome created an automation tab without an id");
        }
        await navigateTab({
          tabId: tab.id,
          url: call.url || "about:blank",
          milestone: "commit",
          timeoutMs: COMMAND_DEADLINES_MS.navigateDefault,
          initScriptSource: navigationInitScriptSource(),
        });
        await bringToFront(await chrome.tabs.get(tab.id));
        return formatTab(await chrome.tabs.get(tab.id));
      });
    case "activate":
      return browserProgram("may-mutate", "tab", call.op, params, async (operationParams) => {
        const tab = await getTabByParams(operationParams, { createOwnedTarget: false });
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        return formatTab(await chrome.tabs.get(tab.id));
      });
    case "close":
      return browserProgram("may-mutate", "tab", call.op, params, async (operationParams) => {
        const tab = await getTabByParams(operationParams, { createOwnedTarget: false });
        await chrome.tabs.remove(tab.id);
        await releaseAutomationTargetTab(tab.id);
        return { closed: tab.id };
      });
    case "group":
      return browserProgram("may-mutate", "tab", call.op, params, async (operationParams) => {
        const tab = await getTabByParams(operationParams, { createOwnedTarget: false });
        return groupTab(tab, command.session.groupTitle, call.groupColor);
      });
    case "ungroup":
      return browserProgram("may-mutate", "tab", call.op, params, async (operationParams) => {
        const tab = await getTabByParams(operationParams, { createOwnedTarget: false });
        if (typeof tab.groupId === "number" && tab.groupId >= 0) {
          await chrome.tabs.ungroup(tab.id);
        }
        const current = await chrome.tabs.get(tab.id);
        return formatTab(current);
      });
    default:
      return assertNever(call);
  }
};

const interpretPageCommand = (command: CommandFor<"page">): BrowserProgram => {
  const operation = command.call.operation;
  const context = commandContext(command, command.call.target);

  switch (operation.kind) {
    case "snapshot": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, snapshotInTab),
      );
    }
    case "read": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, readInTab),
      );
    }
    case "inspect": {
      const params = { ...context, ...operation, ...elementParams(operation.element) };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, inspectInTab),
      );
    }
    case "navigate": {
      const params = { ...context, ...operation };
      return browserProgram(
        "may-mutate",
        "page",
        operation.kind,
        params,
        async (operationParams) => {
          return withExactTab(operationParams, async (exactParams) => {
            const { tab } = exactParams;
            if (exactParams.foreground) await bringToFront(tab);
            await navigateTab({
              tabId: tab.id,
              url: exactParams.url,
              milestone: exactParams.waitUntilLoad === true ? "load" : "commit",
              timeoutMs: exactParams.timeoutMs ?? COMMAND_DEADLINES_MS.navigateDefault,
              initScriptSource: navigationInitScriptSource(exactParams.initScript),
            });
            const observedTab = await formatTab(await chrome.tabs.get(tab.id));
            if (!exactParams.snapshot) return observedTab;
            const snapshot = await snapshotInTab({
              ...exactParams,
              ...exactParams.snapshot,
              foreground: false,
            });
            return { tab: observedTab, snapshot };
          });
        },
      );
    }
    case "evaluate": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, evaluateInTab),
      );
    }
    case "wait": {
      const params = {
        ...context,
        ...operation,
        conditionBy: operation.condition.by,
        conditionValue: operation.condition.value,
      };
      return browserProgram(
        "may-mutate",
        "page",
        operation.kind,
        params,
        async (operationParams) => {
          return withExactTab(operationParams, async (exactParams) => {
            if (exactParams.foreground) await bringToFront(exactParams.tab);
            const timeoutMs = exactParams.timeoutMs ?? COMMAND_DEADLINES_MS.waitDefault;
            const intervalMs = exactParams.intervalMs ?? COMMAND_DEADLINES_MS.waitIntervalDefault;
            const started = Date.now();
            while (true) {
              const elapsedBeforeEvaluation = Date.now() - started;
              const projection = (await evaluateInTab({
                ...exactParams,
                expression: waitProjectionExpression(
                  exactParams.conditionBy,
                  exactParams.conditionValue,
                ),
                foreground: false,
                awaitPromise: true,
                evaluationTimeoutMs: Math.max(1, timeoutMs - elapsedBeforeEvaluation),
              })) as WaitProjection;
              const elapsedMs = Date.now() - started;
              if (projection.satisfied) return { ...projection, elapsedMs };
              if (elapsedMs >= timeoutMs) return { ...projection, elapsedMs };
              await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
              const elapsedAfterSleep = Date.now() - started;
              if (elapsedAfterSleep >= timeoutMs) {
                return { ...projection, elapsedMs: elapsedAfterSleep };
              }
            }
          });
        },
      );
    }
    case "console": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          executeInTab(exactParams, listConsoleMessages, [exactParams.clear === true]),
        ),
      );
    }
    case "network-list": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          executeInTab(exactParams, listNetworkRequests, [
            exactParams.includePreserved === true,
            exactParams.clear === true,
          ]),
        ),
      );
    }
    case "network-get": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          executeInTab(exactParams, getNetworkRequest, [exactParams.requestId]),
        ),
      );
    }
    case "screenshot": {
      const params = { ...context, ...operation };
      return browserProgram("may-mutate", "page", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, takeScreenshot),
      );
    }
    default:
      return assertNever(operation);
  }
};

type KeyOperation = Extract<CommandFor<"input">["call"]["operation"], { readonly kind: "key" }>;

const modifiersFor = (modifiers: KeyOperation["modifiers"]): CdpModifierState | undefined =>
  modifiers && {
    shiftKey: modifiers.shift,
    ctrlKey: modifiers.control,
    altKey: modifiers.alt,
    metaKey: modifiers.meta,
  };

const interpretInputCommand = (command: CommandFor<"input">): BrowserProgram => {
  const operation = command.call.operation;
  const context = commandContext(command, command.call.target);

  switch (operation.kind) {
    case "click": {
      const params = { ...context, ...operation, ...pointerParams(operation.at) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          withPostActionVerification(exactParams, chromeInputClick),
        ),
      );
    }
    case "type": {
      const params = { ...context, ...operation, ...elementParams(operation.into) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          withPostActionVerification(exactParams, chromeInputType),
        ),
      );
    }
    case "fill": {
      const params = { ...context, ...operation, ...elementParams(operation.into) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          withPostActionVerification(exactParams, chromeInputFill),
        ),
      );
    }
    case "key": {
      const params = {
        ...context,
        ...operation,
        ...elementParams(operation.at),
        modifiers: modifiersFor(operation.modifiers),
      };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) =>
          withPostActionVerification(exactParams, chromeInputKey),
        ),
      );
    }
    case "hover": {
      const params = { ...context, ...operation, ...pointerParams(operation.at) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, chromeInputHover),
      );
    }
    case "drag": {
      const from =
        operation.from.by === "coordinate"
          ? { fromX: operation.from.x, fromY: operation.from.y }
          : operation.from.by === "uid"
            ? { fromUid: operation.from.value }
            : { fromSelector: operation.from.value };
      const to =
        operation.to.by === "coordinate"
          ? { toX: operation.to.x, toY: operation.to.y }
          : operation.to.by === "uid"
            ? { toUid: operation.to.value }
            : { toSelector: operation.to.value };
      const params = {
        ...context,
        ...from,
        ...to,
        ...(operation.steps === undefined ? {} : { steps: operation.steps }),
      };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, chromeInputDrag),
      );
    }
    case "tap": {
      const params = { ...context, ...operation, ...pointerParams(operation.at) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, chromeInputTap),
      );
    }
    case "scroll": {
      const params = { ...context, ...operation, ...elementParams(operation.within) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, chromeInputScroll),
      );
    }
    case "upload": {
      const params = { ...context, ...operation, ...elementParams(operation.into) };
      return browserProgram("may-mutate", "input", operation.kind, params, (operationParams) =>
        withExactTab(operationParams, chromeInputUpload),
      );
    }
    default:
      return assertNever(operation);
  }
};

const interpretSystemCommand = (command: CommandFor<"system">): BrowserProgram => {
  const call = command.call;
  const context = commandContext(command, "target" in call ? call.target : undefined);
  const params = { ...context, call };

  switch (call.op) {
    case "version":
      return browserProgram("read-only", "system", call.op, params, () => ({
        extensionId: chrome.runtime.id,
        extensionDisplayVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
      }));
    case "automation-status":
      return browserProgram("read-only", "system", call.op, params, async () => {
        const target = await getAutomationTargetStatus(command.session.key);
        return {
          ...target,
          input: inputStatus(),
        };
      });
    case "cleanup":
      return browserProgram("may-mutate", "system", call.op, params, () =>
        cleanupAutomationTarget(command.session.key),
      );
    case "cleanup-all":
      return browserProgram("may-mutate", "system", call.op, params, cleanupAllAutomationTargets);
    case "probe":
      return browserProgram("may-mutate", "system", call.op, params, (operationParams) =>
        withExactTab(operationParams, (exactParams) => executeInTab(exactParams, probePage, [])),
      );
    default:
      return assertNever(call);
  }
};

const interpretBrowserCommand = (command: WireCommand): BrowserProgram => {
  switch (command.domain) {
    case "tab":
      return interpretTabCommand(command);
    case "page":
      return interpretPageCommand(command);
    case "input":
      return interpretInputCommand(command);
    case "system":
      return interpretSystemCommand(command);
    default:
      return assertNever(command);
  }
};

export const projectBrowserCommand = (command: WireCommand): BrowserCommandProjection => {
  const program = interpretBrowserCommand(command);
  return {
    domain: program.domain,
    operation: program.operation,
    effect: program.effect,
    params: program.params,
  };
};

export async function dispatchBrowserCommand(command: WireCommand): Promise<unknown> {
  const program = interpretBrowserCommand(command);
  try {
    return await program.execute();
  } catch (cause) {
    if (cause instanceof BrowserRejected || cause instanceof BrowserOutcomeUnknown) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (program.effect === "may-mutate") {
      throw new BrowserOutcomeUnknown(
        `${program.domain}.${program.operation} may have changed Chrome before it failed: ${message}. The command was not replayed.`,
        { cause },
      );
    }
    throw new BrowserRejected(`${program.domain}.${program.operation} failed: ${message}`, {
      cause,
    });
  }
}

export {
  detachAllDebuggers,
  detachExpiredDebuggers,
  handleDebuggerDetach,
  handleDebuggerEvent,
} from "./platform-cdp.js";
export { handleAutomationTabRemoved } from "./platform-targets.js";
