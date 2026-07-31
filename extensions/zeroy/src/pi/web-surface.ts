import type { JsonValue } from "@pipee/companion-contracts/web-surface";
import type { ExternalCheck } from "../domain/checker.js";
import type { SiteConnection } from "../domain/connection.js";
import type { JsonRecord } from "../domain/protocol.js";
import type { SiteWorkspaceStatus } from "../domain/site-workspace.js";

export type ZeroYSiteView = {
  readonly siteId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly state: "ready" | "failed";
  readonly error: string | null;
  readonly site: JsonRecord | null;
  readonly schema: JsonRecord | null;
  readonly inventory: JsonRecord | null;
  readonly acf: JsonRecord | null;
  readonly integrity: JsonRecord | null;
  readonly siteRelease: JsonRecord | null;
  readonly activeRelease: JsonRecord | null;
  readonly activeSiteLogic: JsonRecord | null;
  readonly migrationHistory: JsonRecord | null;
  readonly releases: JsonRecord | null;
  readonly checkouts: ReadonlyArray<SiteWorkspaceStatus>;
  readonly externalCheck: ExternalCheck | null;
};

export const projectZeroYWebView = (
  sites: ReadonlyArray<ZeroYSiteView>,
  observedAt: string,
): JsonValue =>
  JSON.parse(
    JSON.stringify({
      kind: "zeroy/web-surface@1",
      observedAt,
      sites,
    }),
  ) as JsonValue;

export const failedSiteView = (connection: SiteConnection, error: string): ZeroYSiteView => ({
  siteId: connection.siteId,
  label: connection.label,
  endpoint: connection.endpoint,
  state: "failed",
  error,
  site: null,
  schema: null,
  inventory: null,
  acf: null,
  integrity: null,
  siteRelease: null,
  activeRelease: null,
  activeSiteLogic: null,
  migrationHistory: null,
  releases: null,
  checkouts: [],
  externalCheck: null,
});
