import type { JsonValue } from "@pi-suite/companion-contracts/web-surface";
import { Schema } from "effect";
import type { ChromeStatusProjection } from "./status-projection.js";

export const ChromeWebAction = Schema.Union([
  Schema.TaggedStruct("NewTab", { url: Schema.String }),
  Schema.TaggedStruct("Activate", { tabId: Schema.Int }),
  Schema.TaggedStruct("Snapshot", { tabId: Schema.Int }),
  Schema.TaggedStruct("Screenshot", { tabId: Schema.Int }),
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

export const projectChromeWebView = (
  status: ChromeStatusProjection,
  tabs: ReadonlyArray<ChromeWebTab>,
  receipts: ReadonlyArray<ChromeWebReceipt>,
): JsonValue => ({
  kind: "pi-chrome/web-surface",
  version: 1,
  status: status as unknown as JsonValue,
  tabs: tabs.map((tab) => ({ ...tab })),
  receipts: receipts.map((receipt) => ({ ...receipt })),
});
