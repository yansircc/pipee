// Static MAIN-world entry bundled by the MV3 extension build graph.
// It stays free of eval/new Function so strict CSP cannot block observation.
import { inspectTarget, readPage, snapshotPage } from "./snapshot-runtime.js";
import {
  grantActionVerbs,
  markContextRef,
  registerFrontier,
  rememberElement,
} from "./action-core.js";

globalThis.__piChromeSnapshotPage = snapshotPage;
globalThis.__piChromeReadPage = readPage;
globalThis.__piChromeInspectTarget = inspectTarget;
globalThis.__piChromeRememberElement = rememberElement;
globalThis.__piChromeGrantActionVerbs = grantActionVerbs;
globalThis.__piChromeMarkContextRef = markContextRef;
globalThis.__piChromeRegisterFrontier = registerFrontier;
