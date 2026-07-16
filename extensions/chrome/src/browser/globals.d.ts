type PiChromeConsoleMethod = "debug" | "log" | "info" | "warn" | "error";

interface PiChromeConsoleEntry {
  id: number;
  level: string;
  timestamp: number;
  url: string;
  args: Array<unknown>;
}

interface PiChromeNetworkEntry {
  id: string;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  startedAt: number;
  pageUrl: string;
  status: "pending" | number;
  statusText?: string | undefined;
  ok?: boolean | undefined;
  responseUrl?: string | undefined;
  durationMs?: number | undefined;
  responseHeaders?: Array<[string, string]> | undefined;
  responseHeadersText?: string | undefined;
  responseBody?: string | undefined;
  responseBodyTruncated?: boolean | undefined;
  responseBodyError?: unknown;
  error?: unknown;
}

interface PiChromePointerState {
  x: number;
  y: number;
  t: number;
}

interface PiChromeSnapshotDigestLabel {
  uid: string;
  role: string;
  label: string;
  disabled: boolean;
  value?: string | undefined;
  checked?: boolean | undefined;
}

interface PiChromeSnapshotDigest {
  url: string;
  title: string;
  textHash: number;
  focusedUid: string | null;
  modalUid: string | null;
  labels: Array<PiChromeSnapshotDigestLabel>;
}

type PiChromeActionVerb = "click" | "fill" | "press" | "upload";

interface PiChromeElementRef {
  kind: "element";
  element: Element;
  verbs: Set<PiChromeActionVerb>;
  context: boolean;
}

interface PiChromeFrontierRef {
  kind: "frontier";
  projection: "actions" | "content";
  rootUid: string | null;
  offset: number;
  fingerprint: number;
  view?: "content" | "outline" | undefined;
  query?: string | undefined;
}

type PiChromeRegisteredRef = PiChromeElementRef | PiChromeFrontierRef;

interface PiChromePageState {
  nextElementUid: number;
  nextFrontierUid: number;
  refs: Map<string, PiChromeRegisteredRef>;
  console: Array<PiChromeConsoleEntry>;
  network: Array<PiChromeNetworkEntry>;
  nextRequestId: number;
  instrumentationInstalled: boolean;
  lastSnapshotDigest?: PiChromeSnapshotDigest | null | undefined;
  pointer?: PiChromePointerState | undefined;
}

interface Window {
  __PI_CHROME_STATE__?: PiChromePageState;
}

interface Element {
  __piChromeUid?: string;
}

interface Function {
  __piChromeWrapped?: boolean;
}

interface XMLHttpRequest {
  __piChromeRequest?: {
    method?: string;
    url?: string;
  };
}

type PiChromeSnapshotPage = typeof import("./injected/snapshot-runtime.js").snapshotPage;
type PiChromeReadPage = typeof import("./injected/snapshot-runtime.js").readPage;
type PiChromeInspectTarget = typeof import("./injected/snapshot-runtime.js").inspectTarget;
type PiChromeRememberElement = typeof import("./injected/action-core.js").rememberElement;
type PiChromeGrantActionVerbs = typeof import("./injected/action-core.js").grantActionVerbs;
type PiChromeMarkContextRef = typeof import("./injected/action-core.js").markContextRef;
type PiChromeRegisterFrontier = typeof import("./injected/action-core.js").registerFrontier;

declare var __piChromeSnapshotPage: undefined | PiChromeSnapshotPage;
declare var __piChromeReadPage: undefined | PiChromeReadPage;
declare var __piChromeInspectTarget: undefined | PiChromeInspectTarget;
declare var __piChromeRememberElement: undefined | PiChromeRememberElement;
declare var __piChromeGrantActionVerbs: undefined | PiChromeGrantActionVerbs;
declare var __piChromeMarkContextRef: undefined | PiChromeMarkContextRef;
declare var __piChromeRegisterFrontier: undefined | PiChromeRegisterFrontier;
declare const __PI_CHROME_BRIDGE_URL__: string;
declare const __PI_CHROME_PROTOCOL_FINGERPRINT__: string;
