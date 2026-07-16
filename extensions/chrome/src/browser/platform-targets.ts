import type { TabCall } from "../protocol/schema.js";
import type { JsonValue } from "../protocol/json-value.js";
import { AUTOMATION_TARGET_LIMITS } from "../protocol/bridge-contract.js";
import { BrowserOutcomeUnknown, BrowserRejected } from "./browser-command-failure.js";
import { TARGET_BOOTSTRAP_DOCUMENT_PATH } from "./extension-runtime-assets.js";

type GroupColor = Extract<TabCall, { readonly op: "new" }>["groupColor"];
export type ResolvedTab = chrome.tabs.Tab & { readonly id: number; readonly windowId: number };
export type BrowserTargetParams = {
  readonly selectedTabId?: number | undefined;
  readonly urlFragment?: string | undefined;
  readonly titleFragment?: string | undefined;
  readonly sessionKey: string;
  readonly sessionGroupTitle: string;
};

class AutomationOwnershipLost extends BrowserRejected {
  constructor(
    message: string,
    readonly reason: "epoch-changed" | "tab-missing" | "tab-outside-regular-profile",
    recordedTabId: number | null,
  ) {
    super(message, {
      code: "automation-ownership-lost",
      details: { reason, recordedTabId },
    });
  }
}

const DEFAULT_GROUP_COLOR = "blue" satisfies NonNullable<GroupColor>;

// =================== pi-chrome automation target ownership ===================
// A tab id proves ownership only inside the browser epoch that allocated it. A session owns a set
// of targets, but an implicit command may resolve only when that set has cardinality zero or one.
// There is deliberately no active/primary/last-used pointer: callers name an exact tab id once a
// session owns several targets. Groups remain display-only projections.
type AllocatingAutomationTarget = Readonly<{
  state: "allocating";
  epoch: string;
  nonce: string;
  label: string;
}>;

type OwnedAutomationTarget = Readonly<{
  state: "owned";
  epoch: string;
  tabId: number;
  label: string;
}>;

type AutomationTarget = AllocatingAutomationTarget | OwnedAutomationTarget;
type AutomationTargetStore = Readonly<Record<string, ReadonlyArray<AutomationTarget>>>;

type AutomationTargetResolution =
  | Readonly<{ state: "allocation-needed"; target: AllocatingAutomationTarget }>
  | Readonly<{ state: "owned"; target: OwnedAutomationTarget; tab: chrome.tabs.Tab }>
  | Readonly<{
      state: "stale";
      target: AutomationTarget;
      reason: AutomationOwnershipLost["reason"];
    }>;

const AUTOMATION_TARGETS_STORAGE_KEY = "piChromeAutomationTargets";
const BROWSER_EPOCH_STORAGE_KEY = "piChromeBrowserEpoch";
const MAX_AUTOMATION_TARGETS_PER_SESSION = AUTOMATION_TARGET_LIMITS.perSession;
const MAX_AUTOMATION_TARGETS_PER_PROFILE = AUTOMATION_TARGET_LIMITS.perProfile;
let targetTurn: Promise<void> = Promise.resolve();
let browserEpochPromise: Promise<string> | undefined;

const rejected = (code: string, message: string, details?: JsonValue): BrowserRejected =>
  new BrowserRejected(message, {
    code,
    ...(details === undefined ? {} : { details }),
  });

const invalidAutomationTargetState = (message: string): BrowserRejected =>
  rejected("invalid-automation-target-state", message);

function sessionKeyOf(params: BrowserTargetParams): string {
  if (typeof params.sessionKey !== "string" || params.sessionKey.length === 0) {
    throw rejected("missing-session-key", "Chrome automation requires a Pi session key");
  }
  return params.sessionKey;
}

async function readBrowserEpoch(): Promise<string> {
  const stored = (await chrome.storage.session.get(BROWSER_EPOCH_STORAGE_KEY))[
    BROWSER_EPOCH_STORAGE_KEY
  ];
  if (stored !== undefined) {
    if (typeof stored !== "string" || stored.length === 0) {
      throw invalidAutomationTargetState("Invalid Chrome browser epoch state");
    }
    return stored;
  }
  const epoch = globalThis.crypto.randomUUID();
  await chrome.storage.session.set({ [BROWSER_EPOCH_STORAGE_KEY]: epoch });
  return epoch;
}

const currentBrowserEpoch = (): Promise<string> => (browserEpochPromise ??= readBrowserEpoch());

const hasExactKeys = (value: object, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const assertAutomationTargetQuotas = (targets: AutomationTargetStore): void => {
  let profileCount = 0;
  for (const [sessionKey, sessionTargets] of Object.entries(targets)) {
    if (sessionTargets.length === 0) {
      throw invalidAutomationTargetState(
        `Chrome automation target storage contains an empty target set for Pi session ${sessionKey}`,
      );
    }
    if (sessionTargets.length > MAX_AUTOMATION_TARGETS_PER_SESSION) {
      throw invalidAutomationTargetState(
        `Pi session ${sessionKey} stores ${sessionTargets.length} automation targets; maximum is ${MAX_AUTOMATION_TARGETS_PER_SESSION}`,
      );
    }
    profileCount += sessionTargets.length;
  }
  if (profileCount > MAX_AUTOMATION_TARGETS_PER_PROFILE) {
    throw invalidAutomationTargetState(
      `Chrome automation target storage contains ${profileCount} targets; profile maximum is ${MAX_AUTOMATION_TARGETS_PER_PROFILE}`,
    );
  }
};

function decodeAutomationTarget(target: unknown, sessionKey: string): AutomationTarget {
  if (typeof target !== "object" || target === null) {
    throw invalidAutomationTargetState(
      `Invalid Chrome automation target state for Pi session ${sessionKey}`,
    );
  }
  const candidate = target as Record<string, unknown>;
  const commonValid =
    typeof candidate.epoch === "string" &&
    candidate.epoch.length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.length > 0 &&
    candidate.label.length <= 80;
  const allocatingValid =
    candidate.state === "allocating" &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length > 0 &&
    hasExactKeys(candidate, ["state", "epoch", "nonce", "label"]);
  const ownedValid =
    candidate.state === "owned" &&
    typeof candidate.tabId === "number" &&
    Number.isInteger(candidate.tabId) &&
    hasExactKeys(candidate, ["state", "epoch", "tabId", "label"]);
  if (!commonValid || (!allocatingValid && !ownedValid)) {
    throw invalidAutomationTargetState(
      `Invalid Chrome automation target state for Pi session ${sessionKey}`,
    );
  }
  return target as AutomationTarget;
}

const targetIdentity = (target: AutomationTarget): string =>
  target.state === "allocating" ? `allocation:${target.nonce}` : `tab:${target.tabId}`;

async function readAutomationTargets(): Promise<AutomationTargetStore> {
  const stored = (await chrome.storage.local.get(AUTOMATION_TARGETS_STORAGE_KEY))[
    AUTOMATION_TARGETS_STORAGE_KEY
  ];
  if (stored === undefined) return {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    throw invalidAutomationTargetState("Invalid Chrome automation targets state");
  }
  const decoded = Object.fromEntries(
    Object.entries(stored).map(([sessionKey, value]) => {
      if (!Array.isArray(value) || value.length === 0) {
        throw invalidAutomationTargetState(
          `Invalid Chrome automation target set for Pi session ${sessionKey}`,
        );
      }
      const sessionTargets = value.map((target) => decodeAutomationTarget(target, sessionKey));
      const identities = sessionTargets.map(targetIdentity);
      if (new Set(identities).size !== identities.length) {
        throw invalidAutomationTargetState(
          `Pi session ${sessionKey} contains duplicate Chrome automation targets`,
        );
      }
      return [sessionKey, sessionTargets] as const;
    }),
  );
  assertAutomationTargetQuotas(decoded);
  return decoded;
}

async function persistAutomationTargets(targets: AutomationTargetStore): Promise<void> {
  assertAutomationTargetQuotas(targets);
  if (Object.keys(targets).length === 0) {
    await chrome.storage.local.remove(AUTOMATION_TARGETS_STORAGE_KEY);
  } else {
    await chrome.storage.local.set({ [AUTOMATION_TARGETS_STORAGE_KEY]: targets });
  }
}

async function appendAutomationTarget(sessionKey: string, target: AutomationTarget): Promise<void> {
  const targets = await readAutomationTargets();
  const sessionTargets = targets[sessionKey] ?? [];
  const profileCount = Object.values(targets).reduce((count, entries) => count + entries.length, 0);
  if (sessionTargets.length >= MAX_AUTOMATION_TARGETS_PER_SESSION) {
    throw rejected(
      "automation-target-limit",
      `Pi session ${sessionKey} already owns ${sessionTargets.length} Chrome automation targets; maximum is ${MAX_AUTOMATION_TARGETS_PER_SESSION}. Close an owned tab before creating another.`,
      {
        scope: "session",
        limit: MAX_AUTOMATION_TARGETS_PER_SESSION,
        current: sessionTargets.length,
      },
    );
  }
  if (profileCount >= MAX_AUTOMATION_TARGETS_PER_PROFILE) {
    throw rejected(
      "automation-target-limit",
      `The paired Chrome profile already stores ${profileCount} automation targets; maximum is ${MAX_AUTOMATION_TARGETS_PER_PROFILE}. Run /chrome unpair to clean every session target before pairing again.`,
      {
        scope: "profile",
        limit: MAX_AUTOMATION_TARGETS_PER_PROFILE,
        current: profileCount,
      },
    );
  }
  await persistAutomationTargets({
    ...targets,
    [sessionKey]: [...sessionTargets, target],
  });
}

async function replaceAutomationTarget(
  sessionKey: string,
  previous: AutomationTarget,
  replacement: AutomationTarget,
): Promise<void> {
  const targets = await readAutomationTargets();
  const sessionTargets = targets[sessionKey] ?? [];
  const identity = targetIdentity(previous);
  if (!sessionTargets.some((target) => targetIdentity(target) === identity)) {
    throw invalidAutomationTargetState(
      `Pi session ${sessionKey} lost automation target ${identity} during allocation`,
    );
  }
  const updated = {
    ...targets,
    [sessionKey]: sessionTargets.map((target) =>
      targetIdentity(target) === identity ? replacement : target,
    ),
  };
  await persistAutomationTargets(updated);
}

async function removeAutomationTarget(sessionKey: string, target: AutomationTarget): Promise<void> {
  const targets = await readAutomationTargets();
  const sessionTargets = targets[sessionKey];
  if (!sessionTargets) return;
  const identity = targetIdentity(target);
  const retained = sessionTargets.filter((entry) => targetIdentity(entry) !== identity);
  if (retained.length === sessionTargets.length) return;
  if (retained.length === 0) {
    const updated = { ...targets };
    delete updated[sessionKey];
    await persistAutomationTargets(updated);
    return;
  }
  await persistAutomationTargets({ ...targets, [sessionKey]: retained });
}

const targetBootstrapUrl = (): string => chrome.runtime.getURL(TARGET_BOOTSTRAP_DOCUMENT_PATH);

const allocationUrl = (target: Pick<AllocatingAutomationTarget, "nonce">): string =>
  `${targetBootstrapUrl()}#${target.nonce}`;

const isAllocationUrl = (url: string): boolean => url.startsWith(`${targetBootstrapUrl()}#`);

async function withTargetTurn<A>(operation: () => Promise<A>): Promise<A> {
  const previous = targetTurn;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  targetTurn = current;
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function regularNormalWindows(): Promise<chrome.windows.Window[]> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.filter(
    (window) =>
      typeof window.id === "number" && window.type === "normal" && window.incognito !== true,
  );
}

const staleResolution = (
  target: AutomationTarget,
  reason: AutomationOwnershipLost["reason"],
): AutomationTargetResolution => ({ state: "stale", target, reason });

const ownershipLost = (
  sessionKey: string,
  target: AutomationTarget,
  reason: AutomationOwnershipLost["reason"],
): AutomationOwnershipLost =>
  new AutomationOwnershipLost(
    reason === "epoch-changed"
      ? `Pi session ${sessionKey} has automation ownership from a previous browser epoch. ` +
          "Run /chrome cleanup before creating a replacement; no existing tab was adopted or closed."
      : reason === "tab-missing"
        ? `Pi session ${sessionKey} lost its exact automation tab. ` +
          "Run /chrome cleanup before creating a replacement; no other tab was adopted or closed."
        : `Pi session ${sessionKey}'s automation tab left the paired profile's regular windows. ` +
          "Run /chrome cleanup before creating a replacement; no other tab was adopted or closed.",
    reason,
    target.state === "owned" ? target.tabId : null,
  );

const resolutionDetails = (
  resolutions: ReadonlyArray<AutomationTargetResolution>,
): ReadonlyArray<Readonly<Record<string, string | number | null>>> =>
  resolutions.map((resolution) => {
    switch (resolution.state) {
      case "owned":
        return {
          state: "owned",
          tabId: resolution.tab.id ?? null,
          title: resolution.tab.title ?? "",
          url: resolution.tab.url ?? "",
        };
      case "allocation-needed":
        return { state: "allocating", tabId: null };
      case "stale":
        return {
          state: "stale",
          tabId: resolution.target.state === "owned" ? resolution.target.tabId : null,
          reason: resolution.reason,
        };
    }
  });

const ambiguousAutomationTarget = (
  sessionKey: string,
  resolutions: ReadonlyArray<AutomationTargetResolution>,
): BrowserRejected =>
  rejected(
    "ambiguous-owned-target",
    `Pi session ${sessionKey} owns ${resolutions.length} Chrome automation targets. Pass one exact target id.`,
    { ownedTargets: resolutionDetails(resolutions) },
  );

const resolveAutomationTargets = async (
  sessionKey: string,
  recoverAllocation = true,
): Promise<ReadonlyArray<AutomationTargetResolution>> => {
  const targets = (await readAutomationTargets())[sessionKey] ?? [];
  if (targets.length === 0) return [];
  const epoch = await currentBrowserEpoch();
  const normalWindows = await regularNormalWindows();
  const normalWindowIds = new Set(normalWindows.map((window) => window.id as number));
  const tabs =
    recoverAllocation && targets.some((target) => target.state === "allocating")
      ? await chrome.tabs.query({})
      : [];
  const resolutions: AutomationTargetResolution[] = [];

  for (const target of targets) {
    if (target.epoch !== epoch) {
      resolutions.push(staleResolution(target, "epoch-changed"));
      continue;
    }
    if (target.state === "allocating") {
      if (!recoverAllocation) {
        resolutions.push({ state: "allocation-needed", target });
        continue;
      }
      const allocating = tabs.filter(
        (candidate) =>
          typeof candidate.id === "number" &&
          normalWindowIds.has(candidate.windowId) &&
          candidate.incognito !== true &&
          candidate.url === allocationUrl(target),
      );
      if (allocating.length > 1) {
        throw invalidAutomationTargetState(
          `Pi session ${sessionKey} has multiple tabs carrying allocation nonce ${target.nonce}`,
        );
      }
      const candidate = allocating[0];
      if (!candidate || typeof candidate.id !== "number") {
        resolutions.push({ state: "allocation-needed", target });
        continue;
      }
      await groupTab(candidate, target.label);
      const tab = await chrome.tabs.get(candidate.id);
      const owned: OwnedAutomationTarget = {
        state: "owned",
        epoch,
        tabId: candidate.id,
        label: target.label,
      };
      await replaceAutomationTarget(sessionKey, target, owned);
      resolutions.push({ state: "owned", target: owned, tab });
      continue;
    }
    const tab = await chrome.tabs.get(target.tabId).catch(() => null);
    if (!tab || typeof tab.id !== "number") {
      resolutions.push(staleResolution(target, "tab-missing"));
      continue;
    }
    if (!normalWindowIds.has(tab.windowId) || tab.incognito === true) {
      resolutions.push(staleResolution(target, "tab-outside-regular-profile"));
      continue;
    }
    resolutions.push({ state: "owned", target, tab });
  }
  return resolutions;
};

// Create the session tab in a window that already belongs to this connector's regular profile.
// The group is only a display label. Ownership is the current epoch plus the exact returned tab id.
async function createAutomationTarget(
  sessionKey: string,
  target: AllocatingAutomationTarget,
  normalWindows: ReadonlyArray<chrome.windows.Window>,
  groupColor?: GroupColor,
) {
  const windowId = normalWindows[0]?.id;
  if (typeof windowId !== "number") {
    throw rejected(
      "chrome-window-required",
      "Chrome automation target requires a regular window id",
    );
  }
  const tab = await chrome.tabs.create({ url: allocationUrl(target), active: false, windowId });
  if (typeof tab.id !== "number") {
    throw new BrowserOutcomeUnknown("Chrome created an automation tab without an id", {
      cause: "tabs.create returned no tab id",
    });
  }

  try {
    await groupTab(tab, target.label, groupColor);
    const grouped = await chrome.tabs.get(tab.id);
    await replaceAutomationTarget(sessionKey, target, {
      state: "owned",
      epoch: target.epoch,
      tabId: tab.id,
      label: target.label,
    });
    return grouped;
  } catch (error) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (closeError) {
      const openTabs = await chrome.tabs.query({}).catch((probeError: unknown) => {
        throw new AggregateError(
          [error, closeError, probeError],
          `Chrome target creation failed and tab ${tab.id} closure could not be verified; allocation ownership was retained`,
        );
      });
      if (openTabs.some((candidate) => candidate.id === tab.id)) {
        throw new AggregateError(
          [error, closeError],
          `Chrome target creation failed and tab ${tab.id} remained open; allocation ownership was retained`,
        );
      }
    }
    try {
      await removeAutomationTarget(sessionKey, target);
    } catch (clearError) {
      throw new AggregateError(
        [error, clearError],
        `Chrome target creation failed after tab ${tab.id} was closed; allocation ownership cleanup must be retried`,
      );
    }
    throw error;
  }
}

async function getOwnedAutomationTarget(sessionKey: string) {
  return withTargetTurn(async () => {
    const current = await resolveAutomationTargets(sessionKey, false);
    if (current.length === 0) return null;
    if (current.length > 1) throw ambiguousAutomationTarget(sessionKey, current);
    const resolution = (await resolveAutomationTargets(sessionKey))[0]!;
    if (resolution.state === "owned") return resolution.tab;
    if (resolution.state === "stale")
      throw ownershipLost(sessionKey, resolution.target, resolution.reason);
    throw rejected(
      "automation-target-allocation-pending",
      `Pi session ${sessionKey} has an unfinished Chrome automation target allocation. Run /chrome cleanup before retrying.`,
    );
  });
}

// One ownership turn prevents duplicate allocation and lost map updates across all sessions.
async function getOrCreateAutomationTarget(sessionKey: string, groupTitle: string) {
  return withTargetTurn(async () => {
    const label = cleanGroupTitle(groupTitle);
    const current = await resolveAutomationTargets(sessionKey, false);
    if (current.length > 1) throw ambiguousAutomationTarget(sessionKey, current);
    const resolution =
      current.length === 0 ? undefined : (await resolveAutomationTargets(sessionKey))[0];
    if (resolution?.state === "owned") return resolution.tab;
    if (resolution?.state === "stale")
      throw ownershipLost(sessionKey, resolution.target, resolution.reason);
    const normalWindows = await regularNormalWindows();
    if (normalWindows.length === 0) {
      throw rejected(
        "chrome-window-required",
        "No regular Chrome window is open in the bound Chrome profile. " +
          "Open the bound Chrome profile and try again.",
      );
    }
    const target =
      resolution?.state === "allocation-needed"
        ? resolution.target
        : ({
            state: "allocating",
            epoch: await currentBrowserEpoch(),
            nonce: globalThis.crypto.randomUUID(),
            label,
          } as const);
    if (!resolution) await appendAutomationTarget(sessionKey, target);
    return createAutomationTarget(sessionKey, target, normalWindows);
  });
}

export async function createNewAutomationTarget(
  sessionKey: string,
  groupTitle: string,
  groupColor?: GroupColor,
) {
  return withTargetTurn(async () => {
    const label = cleanGroupTitle(groupTitle);
    const resolutions = await resolveAutomationTargets(sessionKey, false);
    const stale = resolutions.find((resolution) => resolution.state === "stale");
    if (stale?.state === "stale") {
      throw ownershipLost(sessionKey, stale.target, stale.reason);
    }
    if (resolutions.some((resolution) => resolution.state === "allocation-needed")) {
      throw rejected(
        "automation-target-allocation-pending",
        `Pi session ${sessionKey} has an unfinished Chrome automation target allocation. Run /chrome cleanup before creating another tab.`,
      );
    }
    const normalWindows = await regularNormalWindows();
    if (normalWindows.length === 0) {
      throw rejected(
        "chrome-window-required",
        "No regular Chrome window is open in the bound Chrome profile. " +
          "Open the bound Chrome profile and try again.",
      );
    }
    const target = {
      state: "allocating",
      epoch: await currentBrowserEpoch(),
      nonce: globalThis.crypto.randomUUID(),
      label,
    } as const;
    await appendAutomationTarget(sessionKey, target);
    return createAutomationTarget(sessionKey, target, normalWindows, groupColor);
  });
}

export async function getAutomationTargetStatus(sessionKey: string) {
  return withTargetTurn(async () => {
    const resolutions = await resolveAutomationTargets(sessionKey, false);
    return {
      targets: await Promise.all(
        resolutions.map(async (resolution) => {
          switch (resolution.state) {
            case "owned":
              return { state: "owned" as const, tab: await formatTab(resolution.tab) };
            case "allocation-needed":
              return { state: "allocating" as const };
            case "stale":
              return {
                state: "stale" as const,
                reason: resolution.reason,
                recordedTabId: resolution.target.state === "owned" ? resolution.target.tabId : null,
              };
          }
        }),
      ),
    };
  });
}

// Cleanup owns only the session's recorded target set. Windows and every other tab remain outside
// this boundary.
export async function cleanupAutomationTarget(sessionKey: string) {
  return withTargetTurn(async () => {
    const cleanup = await planAutomationTargetCleanup(sessionKey);
    return executeAutomationTargetCleanup(cleanup);
  });
}

type AutomationTargetCleanup = Readonly<{
  sessionKey: string;
  target: AutomationTarget;
  tabId: number | null;
  stale: boolean;
}>;

const planAutomationTargetCleanup = async (
  onlySessionKey?: string,
): Promise<ReadonlyArray<AutomationTargetCleanup>> => {
  const targets = await readAutomationTargets();
  if (Object.keys(targets).length === 0) return [];
  const epoch = await currentBrowserEpoch();
  const normalWindows = await regularNormalWindows();
  const normalWindowIds = new Set(normalWindows.map((window) => window.id as number));
  const selectedTargets = Object.entries(targets).filter(
    ([sessionKey]) => onlySessionKey === undefined || sessionKey === onlySessionKey,
  );
  const allocatingTabs = selectedTargets.some(([, sessionTargets]) =>
    sessionTargets.some((target) => target.epoch === epoch && target.state === "allocating"),
  )
    ? await chrome.tabs.query({})
    : [];
  const cleanup: AutomationTargetCleanup[] = [];

  for (const [sessionKey, sessionTargets] of selectedTargets) {
    for (const target of sessionTargets) {
      if (target.epoch !== epoch) {
        cleanup.push({ sessionKey, target, tabId: null, stale: true });
        continue;
      }

      if (target.state === "allocating") {
        const candidates = allocatingTabs.filter(
          (candidate) =>
            typeof candidate.id === "number" &&
            normalWindowIds.has(candidate.windowId) &&
            candidate.incognito !== true &&
            candidate.url === allocationUrl(target),
        );
        if (candidates.length > 1) {
          throw invalidAutomationTargetState(
            `Pi session ${sessionKey} has multiple tabs carrying allocation nonce ${target.nonce}`,
          );
        }
        const candidate = candidates[0];
        cleanup.push({
          sessionKey,
          target,
          tabId: candidate && typeof candidate.id === "number" ? candidate.id : null,
          stale: candidate === undefined,
        });
        continue;
      }

      const tab = await chrome.tabs.get(target.tabId).catch(() => null);
      const provablyOwned =
        tab !== null &&
        typeof tab.id === "number" &&
        normalWindowIds.has(tab.windowId) &&
        tab.incognito !== true;
      cleanup.push({
        sessionKey,
        target,
        tabId: provablyOwned ? target.tabId : null,
        stale: !provablyOwned,
      });
    }
  }

  return cleanup;
};

const executeAutomationTargetCleanup = async (cleanup: ReadonlyArray<AutomationTargetCleanup>) => {
  const closedTabIds: number[] = [];
  let staleOwnershipsCleared = 0;
  for (const action of cleanup) {
    if (action.tabId !== null) {
      await chrome.tabs.remove(action.tabId);
      closedTabIds.push(action.tabId);
    }
    if (action.stale) staleOwnershipsCleared += 1;
    await removeAutomationTarget(action.sessionKey, action.target);
  }
  return { closedTabIds, staleOwnershipsCleared } as const;
};

// Profile cleanup closes only current-epoch tabs proven by the ownership map. Stale records are
// forgotten without adopting or closing any tab, and every successful step is retry-safe.
export async function cleanupAllAutomationTargets() {
  return withTargetTurn(async () => {
    const cleanup = await planAutomationTargetCleanup();
    const clearedSessionCount = new Set(cleanup.map((action) => action.sessionKey)).size;
    const result = await executeAutomationTargetCleanup(cleanup);
    return {
      ...result,
      clearedSessionCount,
    } as const;
  });
}

export async function releaseAutomationTargetTab(tabId: number): Promise<void> {
  await withTargetTurn(async () => {
    const epoch = await currentBrowserEpoch();
    const targets = await readAutomationTargets();
    let changed = false;
    const retained = Object.fromEntries(
      Object.entries(targets).flatMap(([sessionKey, sessionTargets]) => {
        const entries = sessionTargets.filter(
          (target) => target.state !== "owned" || target.epoch !== epoch || target.tabId !== tabId,
        );
        if (entries.length !== sessionTargets.length) changed = true;
        return entries.length === 0 ? [] : [[sessionKey, entries] as const];
      }),
    );
    if (!changed) return;
    await persistAutomationTargets(retained);
  });
}

export async function handleAutomationTabRemoved(
  tabId: number,
  _removeInfo: chrome.tabs.OnRemovedInfo,
): Promise<void> {
  await releaseAutomationTargetTab(tabId);
}

function cleanGroupTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return text || "Pi";
}

async function groupRecord(groupId: number | undefined) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  return {
    id: group.id,
    title: group.title || "",
    color: group.color || "",
    collapsed: Boolean(group.collapsed),
    windowId: group.windowId,
  };
}

// Group titles are display-only. An ungrouped tab always gets a fresh group; no title lookup may
// select a user group, window, or ownership record.
export async function groupTab(tab: chrome.tabs.Tab, title: string, color?: GroupColor) {
  if (!chrome.tabGroups)
    throw new Error(
      "chrome.tabGroups API unavailable; reload the extension after granting the tabGroups permission",
    );
  if (!tab || typeof tab.id !== "number") throw new Error("No tab to group");
  const groupTitle = cleanGroupTitle(title);
  if (typeof tab.groupId === "number" && tab.groupId >= 0) {
    await chrome.tabs.ungroup(tab.id);
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: groupTitle,
    color: color ?? DEFAULT_GROUP_COLOR,
    collapsed: false,
  });
  const grouped = await chrome.tabs.get(tab.id);
  return formatTab(grouped);
}

export async function formatTab(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    ...(tab.status === undefined ? {} : { status: tab.status }),
    ...(tab.pinned === undefined ? {} : { pinned: tab.pinned }),
    ...(tab.incognito === undefined ? {} : { incognito: tab.incognito }),
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    group: await groupRecord(tab.groupId),
  };
}

// Resolve which Chrome tab an action targets.
//
// Explicit targeting (selectedTabId / urlFragment / titleFragment) is unchanged: callers can still
// act on any existing tab, including a user tab, when they ask for it by name. In the implicit
// "no target given" case, zero owned targets may allocate one and exactly one owned target resolves;
// several owned targets are ambiguous and require one exact id.
//
// `createOwnedTarget` controls the implicit case:
//   - true  (default): create the first automation target on first use. Used by every page/content
//     action — page.navigate, click/type/fill/key/hover/drag/scroll/tap/upload, snapshot,
//     inspect, evaluate, screenshot, waitFor, console/network list, probe. These need a live
//     surface to drive, so auto-creating is correct and they no longer touch the user's tab.
//   - false: do NOT create. Used by tab.activate/close/group/ungroup (tab *management*): with no
//     explicit target they operate only when exactly one owned automation target exists, else
//     throw asking for an explicit target — so e.g. `chrome_tab_close` can never silently close
//     the user's active tab the way it used to, and never spawns a throwaway tab just to close it.
export async function getTabByParams(
  params: BrowserTargetParams,
  { createOwnedTarget = true }: { readonly createOwnedTarget?: boolean } = {},
): Promise<ResolvedTab> {
  const tabs = await chrome.tabs.query({}).catch((cause: unknown) => {
    throw new BrowserRejected("Chrome tabs could not be listed", {
      cause,
      code: "tab-list-failed",
    });
  });
  const usesOwnedTarget =
    params.selectedTabId === undefined &&
    params.urlFragment === undefined &&
    params.titleFragment === undefined;
  let tab;
  if (params.selectedTabId !== undefined) {
    const id = params.selectedTabId;
    tab = await chrome.tabs.get(id).catch(() => null);
    if (typeof tab?.id !== "number") {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      const listed = tabs
        .filter((candidate) => candidate.id !== undefined)
        .slice(0, 20)
        .map(
          (candidate) =>
            `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`,
        )
        .join("\n");
      throw rejected(
        "tab-not-found",
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
          `Re-target with chrome_tab_list, or pass urlFragment/titleFragment instead of selectedTabId.\n` +
          `Current tabs:\n${listed || "  (none)"}`,
        {
          target: { by: "id", value: id },
          currentTabs: tabs
            .filter((candidate) => candidate.id !== undefined)
            .slice(0, 20)
            .map((candidate) => ({
              id: candidate.id ?? -1,
              title: candidate.title ?? "",
              url: candidate.url ?? "",
            })),
        },
      );
    }
  } else if (params.urlFragment) {
    const urlFragment = params.urlFragment;
    const matches = tabs.filter((candidate) => (candidate.url || "").includes(urlFragment));
    if (matches.length > 1) {
      throw rejected(
        "ambiguous-tab-target",
        `Chrome tab URL target is ambiguous (${matches.map((candidate) => candidate.id).join(", ")}). ` +
          "Run chrome_tab_list and target one exact tab id.",
        {
          target: { by: "url", value: urlFragment },
          matchingTabIds: matches.flatMap((candidate) =>
            candidate.id === undefined ? [] : [candidate.id],
          ),
        },
      );
    }
    tab = matches[0];
  } else if (params.titleFragment) {
    const titleFragment = params.titleFragment;
    const matches = tabs.filter((candidate) => (candidate.title || "").includes(titleFragment));
    if (matches.length > 1) {
      throw rejected(
        "ambiguous-tab-target",
        `Chrome tab title target is ambiguous (${matches.map((candidate) => candidate.id).join(", ")}). ` +
          "Run chrome_tab_list and target one exact tab id.",
        {
          target: { by: "title", value: titleFragment },
          matchingTabIds: matches.flatMap((candidate) =>
            candidate.id === undefined ? [] : [candidate.id],
          ),
        },
      );
    }
    tab = matches[0];
  } else {
    // No explicit target: resolve by the owned-set cardinality instead of hijacking the user's
    // active tab or maintaining a mutable current-target pointer. Callers name an exact id once the
    // session owns several tabs.
    const sessionKey = sessionKeyOf(params);
    tab = createOwnedTarget
      ? await getOrCreateAutomationTarget(sessionKey, params.sessionGroupTitle)
      : await getOwnedAutomationTarget(sessionKey);
    if (!tab) {
      throw rejected(
        "automation-target-required",
        "No target tab specified and this Pi session has no automation tab yet. " +
          "Pass selectedTabId/urlFragment/titleFragment, or run chrome_navigate first.",
      );
    }
  }
  if (typeof tab?.id !== "number" || typeof tab.windowId !== "number") {
    throw rejected("tab-not-found", "No matching Chrome tab found");
  }
  const url = tab.url || "";
  const isOwnedAllocation = usesOwnedTarget && isAllocationUrl(url);
  if (
    !isOwnedAllocation &&
    (url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("devtools://"))
  ) {
    throw rejected(
      "protected-tab-url",
      `Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}`,
    );
  }
  // Tabs Pi interacts with (page.* actions) join this session's group so the user can see exactly
  // which tabs Pi is driving. We only adopt *ungrouped* tabs — never hijack a tab the user (or
  // another Pi session) already grouped, since groupTab would otherwise rename that group.
  if (usesOwnedTarget && params.sessionGroupTitle) {
    tab = await joinSessionGroup(tab, params.sessionGroupTitle);
  }
  return tab as ResolvedTab;
}

// Add an ungrouped owned tab to a fresh display group; group titles never select identity.
async function joinSessionGroup(tab: chrome.tabs.Tab, title: string) {
  if (typeof tab.id !== "number") throw new Error("No tab to join to the Pi session group");
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return tab;
  await groupTab(tab, title);
  return chrome.tabs.get(tab.id);
}

export async function bringToFront(tab: chrome.tabs.Tab) {
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    throw new Error("Chrome tab cannot be focused without tab and window ids");
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}
