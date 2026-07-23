import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  getPiChromeState,
  grantActionVerbs,
  lookupFrontier,
  lookupPiChromeElement,
  markContextRef,
  prunePiChromeElements,
  rememberElement,
  registerFrontier,
} from "../../src/browser/injected/action-core.js";
import { inspectTarget } from "../../src/browser/injected/snapshot-runtime.js";

type RegistryElement = {
  isConnected: boolean;
  __piChromeUid?: string | undefined;
};

const element = (): RegistryElement => ({ isConnected: true });
const remember = (value: RegistryElement): string => rememberElement(value as unknown as Element);

beforeEach(() => {
  vi.stubGlobal("window", { __PI_CHROME_STATE__: undefined });
});

afterEach(() => vi.unstubAllGlobals());

it("keeps a hard-capped live LRU without a second ordering source", () => {
  const elements = Array.from({ length: 2_048 }, element);
  const uids = elements.map(remember);
  expect(getPiChromeState().refs.size).toBe(2_048);

  const first = elements[0]!;
  expect(lookupPiChromeElement(uids[0]!)).toBe(first);
  const newcomer = element();
  const newcomerUid = remember(newcomer);

  expect(getPiChromeState().refs.size).toBe(2_048);
  expect(lookupPiChromeElement(uids[1]!)).toBeUndefined();
  expect(lookupPiChromeElement(uids[0]!)).toBe(first);
  expect(lookupPiChromeElement(newcomerUid)).toBe(newcomer);
});

it("prunes thousands of replacements and fails closed for detached or evicted UIDs", () => {
  const initial = Array.from({ length: 3_000 }, element);
  const initialUids = initial.map(remember);
  const detached = initial.at(-1)!;
  const detachedUid = initialUids.at(-1)!;
  detached.isConnected = false;

  let previousReplacement: RegistryElement | undefined;
  let latestReplacement: RegistryElement | undefined;
  let latestUid = "";
  for (let index = 0; index < 3_000; index += 1) {
    if (previousReplacement) previousReplacement.isConnected = false;
    latestReplacement = element();
    latestUid = remember(latestReplacement);
    previousReplacement = latestReplacement;
  }

  const state = getPiChromeState();
  prunePiChromeElements(state);
  expect(state.refs.size).toBeLessThanOrEqual(2_048);
  expect(lookupPiChromeElement(detachedUid)).toBeUndefined();
  expect(lookupPiChromeElement(initialUids[0]!)).toBeUndefined();
  expect(lookupPiChromeElement(latestUid)).toBe(latestReplacement);

  expect(() => inspectTarget(initialUids[0]!, null, false)).toThrow("Take a fresh chrome_snapshot");
  expect(state.instrumentationInstalled).toBe(false);
});

it("does one full live sweep per entry instead of one per remembered element", () => {
  let connectivityReads = 0;
  const tracked = (): RegistryElement => {
    const value = {} as RegistryElement;
    Object.defineProperty(value, "isConnected", {
      get: () => {
        connectivityReads += 1;
        return true;
      },
    });
    return value;
  };
  Array.from({ length: 1_000 }, tracked).forEach(remember);
  const afterRemember = connectivityReads;

  remember(element());
  expect(connectivityReads).toBe(afterRemember);

  prunePiChromeElements(getPiChromeState());
  expect(connectivityReads - afterRemember).toBe(1_000);
});

it("stores action, context, and frontier capabilities in one tagged registry", () => {
  const root = element();
  const uid = remember(root);
  grantActionVerbs(uid, ["fill", "press"]);
  markContextRef(uid);
  const frontierUid = registerFrontier({
    projection: "actions",
    rootUid: uid,
    offset: 8,
    fingerprint: 42,
  });

  expect(getPiChromeState().refs.get(uid)).toMatchObject({
    kind: "element",
    element: root,
    context: true,
  });
  expect([...((getPiChromeState().refs.get(uid) as PiChromeElementRef).verbs ?? [])]).toEqual([
    "fill",
    "press",
  ]);
  expect(lookupFrontier(frontierUid)).toMatchObject({
    kind: "frontier",
    projection: "actions",
    rootUid: uid,
    offset: 8,
    fingerprint: 42,
  });
  expect(lookupPiChromeElement(frontierUid)).toBeUndefined();
});
