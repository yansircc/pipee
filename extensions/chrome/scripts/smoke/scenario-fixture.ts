import { randomUUID } from "node:crypto";
import type { WireCommand, WireResult } from "../../src/protocol/schema.js";

const SMOKE_SESSION = {
  key: `connector-smoke-${randomUUID()}`,
  groupTitle: "Pi Chrome Connector Smoke",
  foreground: false,
} as const;

export const VERSION_COMMAND = {
  id: `smoke-${randomUUID()}`,
  domain: "system",
  call: { op: "version" },
  session: SMOKE_SESSION,
} as const satisfies WireCommand;

export const INCOMPATIBLE_COMMAND = {
  ...VERSION_COMMAND,
  id: `smoke-incompatible-${randomUUID()}`,
} as const satisfies WireCommand;

export const pageCommands = (pageUrl: string) =>
  [
    {
      id: `smoke-navigate-${randomUUID()}`,
      domain: "page",
      call: {
        operation: {
          kind: "navigate",
          url: `${pageUrl}?source=first`,
          initScript: "globalThis.__piSmokeInit = 'installed'",
          waitUntilLoad: true,
          timeoutMs: 10_000,
          snapshot: { mode: "text", maxTextChars: 4_000 },
        },
      },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-new-tab-${randomUUID()}`,
      domain: "tab",
      call: { op: "new", url: `${pageUrl}?source=second` },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-wait-second-${randomUUID()}`,
      domain: "page",
      call: {
        target: { by: "url", value: "source=second" },
        operation: {
          kind: "wait",
          condition: { by: "textContains", value: "BETA-SMOKE" },
          timeoutMs: 10_000,
        },
      },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-snapshot-second-${randomUUID()}`,
      domain: "page",
      call: {
        target: { by: "url", value: "source=second" },
        operation: { kind: "snapshot", mode: "text", maxTextChars: 4_000 },
      },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-snapshot-first-${randomUUID()}`,
      domain: "page",
      call: {
        target: { by: "url", value: "source=first" },
        operation: { kind: "snapshot", mode: "text", maxTextChars: 4_000 },
      },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-click-first-${randomUUID()}`,
      domain: "input",
      call: {
        target: { by: "url", value: "source=first" },
        operation: {
          kind: "click",
          at: { by: "selector", value: "#smoke-action" },
          includeSnapshot: true,
        },
      },
      session: { ...SMOKE_SESSION, foreground: true },
    },
    {
      id: `smoke-read-first-${randomUUID()}`,
      domain: "page",
      call: {
        target: { by: "url", value: "source=first" },
        operation: { kind: "read", view: "content", maxChars: 4_000 },
      },
      session: SMOKE_SESSION,
    },
    {
      id: `smoke-cleanup-${randomUUID()}`,
      domain: "system",
      call: { op: "cleanup" },
      session: SMOKE_SESSION,
    },
  ] as const satisfies ReadonlyArray<WireCommand>;

export type SuccessfulWireResult = Extract<WireResult, { readonly ok: true }>;
