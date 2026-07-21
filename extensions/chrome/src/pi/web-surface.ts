import type { JsonValue } from "@pipee/companion-contracts/web-surface";
import { Schema } from "effect";
import type { ChromeStatusProjection } from "./status-projection.js";

export const ChromeWebAction = Schema.Union([
  Schema.TaggedStruct("Terminate", {}),
  Schema.TaggedStruct("Close", { tabId: Schema.Int }),
]);
export type ChromeWebAction = typeof ChromeWebAction.Type;

export interface ChromeWebTab {
  readonly id: number;
  readonly active: boolean;
  readonly title: string;
  readonly url: string;
}

export interface ChromeWebReceipt {
  readonly at: number;
  readonly operation: string;
  readonly tabId?: number;
  readonly result: string;
  readonly evidence?: string;
}

export interface ChromeWebActivity {
  readonly operation: string;
  readonly startedAt: number;
}

export interface ChromeWebEvent {
  readonly at: number;
  readonly operation: string;
  readonly phase: "started" | "completed" | "failed";
  readonly message?: string;
}

export const projectChromeWebView = (
  status: ChromeStatusProjection,
  tabs: ReadonlyArray<ChromeWebTab>,
  receipts: ReadonlyArray<ChromeWebReceipt>,
  activity: ChromeWebActivity | null,
  events: ReadonlyArray<ChromeWebEvent>,
): JsonValue => ({
  kind: "pi-chrome/web-surface",
  version: 1,
  status: status as unknown as JsonValue,
  tabs: tabs.map((tab) => ({ ...tab })),
  receipts: receipts.map((receipt) => ({ ...receipt })),
  activity: activity === null ? null : { ...activity },
  events: events.map((event) => ({ ...event })),
});
