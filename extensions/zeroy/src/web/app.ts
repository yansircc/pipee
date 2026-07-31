import { connectWebSurfaceBrowser } from "@pipee/companion-contracts/web-surface-browser";
import type { JsonValue, WebSurfaceSessionContext } from "@pipee/companion-contracts/web-surface";

type RecordValue = Readonly<Record<string, JsonValue>>;
type View = {
  readonly kind: "zeroy/web-surface@1";
  readonly observedAt: string;
  readonly sites: ReadonlyArray<Site>;
};
type Site = {
  readonly siteId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly state: "ready" | "failed";
  readonly error: string | null;
  readonly site: RecordValue | null;
  readonly schema: RecordValue | null;
  readonly inventory: RecordValue | null;
  readonly acf: RecordValue | null;
  readonly integrity: RecordValue | null;
  readonly siteRelease: RecordValue | null;
  readonly activeRelease: RecordValue | null;
  readonly activeSiteLogic: RecordValue | null;
  readonly migrationHistory: RecordValue | null;
  readonly releases: RecordValue | null;
  readonly checkouts: ReadonlyArray<RecordValue>;
  readonly externalCheck: RecordValue | null;
};

const root = document.querySelector<HTMLDivElement>("#app")!;
const sessions = new Map<string, WebSurfaceSessionContext>();
const views = new Map<
  string,
  { readonly session: WebSurfaceSessionContext; readonly view: View }
>();

const display = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : value === null || value === undefined
      ? ""
      : JSON.stringify(value);
const esc = (value: unknown): string =>
  display(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const asRecord = (value: JsonValue | null | undefined): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const asArray = (value: JsonValue | null | undefined): ReadonlyArray<JsonValue> =>
  Array.isArray(value) ? value : [];
const string = (value: JsonValue | null | undefined, fallback = "—"): string =>
  typeof value === "string" ? value : fallback;
const number = (value: JsonValue | null | undefined, fallback = "0"): string =>
  typeof value === "number" ? String(value) : fallback;
const asNumber = (record: RecordValue, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;
const sessionName = (session: WebSurfaceSessionContext) => session.name || session.sessionId;

const asView = (value: JsonValue | null): View | null => {
  const candidate = asRecord(value);
  if (
    candidate?.kind !== "zeroy/web-surface@1" ||
    typeof candidate.observedAt !== "string" ||
    !Array.isArray(candidate.sites)
  )
    return null;
  return candidate as unknown as View;
};

const localeChips = (site: Site): string => {
  const config = asRecord(site.site?.siteConfig);
  const locales = asArray(config?.enabledLocales);
  return locales
    .map((value) => {
      const locale = asRecord(value);
      if (!locale) return "";
      const id = string(locale.locale);
      const prefix = string(locale.urlPrefix, "");
      const primary = config?.defaultLocale === id ? " primary" : "";
      return `<span class="chip${primary}">${esc(id)}${prefix ? ` · /${esc(prefix)}` : ""}</span>`;
    })
    .join("");
};

const schemaRows = (site: Site): string => {
  const schema = asRecord(site.schema?.schema);
  const schemas = asRecord(schema?.schemas);
  if (!schemas) return '<div class="empty">ThemeSchema 不可用。</div>';
  const documents = Object.entries(schemas)
    .map(([id, raw]) => {
      const definition = asRecord(raw);
      const nodes = asRecord(definition?.nodes);
      return `<section class="subcard"><div class="subhead"><b>${esc(id)}</b><span>${esc(string(definition?.template))}</span></div><div class="nodes">${Object.entries(
        nodes ?? {},
      )
        .map(([nodeId, node]) => {
          const item = asRecord(node);
          return `<div><code>${esc(nodeId)}</code><span>${esc(string(item?.kind))}</span><span>${item?.required === true ? "required" : "optional"}</span><span>${item?.searchable === true ? "search" : ""}</span></div>`;
        })
        .join("")}</div></section>`;
    })
    .join("");
  const collections = asRecord(schema?.collections);
  const collectionRows = Object.entries(collections ?? {})
    .map(([id, raw]) => {
      const collection = asRecord(raw);
      return `<section class="subcard"><div class="subhead"><b>${esc(id)}</b><span>${esc(string(collection?.kind))} · /${esc(string(collection?.route))}</span></div><div class="nodes"><div><code>${esc(string(collection?.schemaId))}</code><span>${esc(string(collection?.template))}</span><span>collection</span><span></span></div></div></section>`;
    })
    .join("");
  return documents + collectionRows;
};

const translationSummary = (locale: RecordValue): string => {
  const summary = asRecord(locale.translation);
  if (!summary) return "";
  const facts = [
    ["missing", "待译"],
    ["stale", "待复核"],
    ["reviewNeeded", "需确认"],
  ] as const;
  const attention = facts
    .map(([key, label]) => {
      const count = asNumber(summary, key);
      return count > 0 ? `${count} ${label}` : "";
    })
    .filter(Boolean);
  return attention.length > 0 ? attention.join(" · ") : `${asNumber(summary, "current")} 已就绪`;
};

const translationCoverageRows = (site: Site): string => {
  const coverage = new Map<
    string,
    { missing: number; stale: number; reviewNeeded: number; current: number; publishedAt: string }
  >();
  for (const itemValue of asArray(site.inventory?.items)) {
    const item = asRecord(itemValue);
    for (const localeValue of asArray(item?.locales)) {
      const locale = asRecord(localeValue);
      if (!locale || typeof locale.locale !== "string") continue;
      const summary = asRecord(locale.translation);
      if (!summary) continue;
      const existing = coverage.get(locale.locale) ?? {
        missing: 0,
        stale: 0,
        reviewNeeded: 0,
        current: 0,
        publishedAt: "",
      };
      coverage.set(locale.locale, {
        missing: existing.missing + asNumber(summary, "missing"),
        stale: existing.stale + asNumber(summary, "stale"),
        reviewNeeded: existing.reviewNeeded + asNumber(summary, "reviewNeeded"),
        current: existing.current + asNumber(summary, "current"),
        publishedAt: [existing.publishedAt, string(locale.lastPublishedAt, "")].sort().at(-1) ?? "",
      });
    }
  }
  if (coverage.size === 0) return '<div class="empty">还没有可统计的语言内容。</div>';
  return `<div class="facts">${[...coverage.entries()]
    .map(
      ([locale, value]) =>
        `<div><span>${esc(locale)}</span><b>${value.missing + value.stale + value.reviewNeeded} 待处理 · ${value.current} 就绪</b><small>${value.publishedAt ? `最近发布 ${esc(value.publishedAt)}` : "尚未发布"}</small></div>`,
    )
    .join("")}</div>`;
};

const inventoryRows = (site: Site): string => {
  const items = asArray(site.inventory?.items);
  if (items.length === 0) return '<div class="empty">还没有 canonical 页面。</div>';
  return items
    .map((value) => {
      const item = asRecord(value);
      if (!item) return "";
      const locales = asArray(item.locales);
      return `<div class="inventory-row"><div class="object"><b>${esc(string(item.postTitle))}</b><span>#${esc(number(item.objectId))} · ${esc(string(item.postType))} · ${esc(string(item.schemaId))}</span></div><div class="locale-states">${locales
        .map((localeValue) => {
          const locale = asRecord(localeValue);
          if (!locale) return "";
          const state = string(locale.state);
          const route =
            typeof locale.url === "string"
              ? `<a href="${esc(locale.url)}" target="_blank" rel="noreferrer">${esc(locale.locale)} ↗</a>`
              : esc(locale.locale);
          const publishedAt = string(locale.lastPublishedAt, "");
          return `<span class="locale-state ${esc(state)}"><b>${route}</b><small>${esc(state)}${locale.revision !== undefined ? ` · r${esc(number(locale.revision))}` : ""}${translationSummary(locale) ? ` · ${esc(translationSummary(locale))}` : ""}${publishedAt ? ` · 发布 ${esc(publishedAt)}` : ""}</small></span>`;
        })
        .join("")}</div></div>`;
    })
    .join("");
};

const acfRows = (site: Site): string => {
  const available = site.acf?.available === true;
  if (!available) return '<div class="empty">此站点未启用 ACF。</div>';
  const groups = asArray(site.acf?.fieldGroups);
  if (groups.length === 0) return '<div class="empty">没有 ACF field groups。</div>';
  return groups
    .map((value) => {
      const group = asRecord(value);
      if (!group) return "";
      const fields = asArray(group.fields);
      return `<section class="subcard"><div class="subhead"><b>${esc(string(group.title))}</b><span>${esc(string(group.key))}</span></div><div class="acf-fields">${fields
        .map((fieldValue) => {
          const field = asRecord(fieldValue);
          if (!field) return "";
          return `<div><code>${esc(string(field.name))}</code><span>${esc(string(field.type))}</span>${field.required === true ? '<span class="required">required</span>' : ""}</div>`;
        })
        .join("")}</div></section>`;
    })
    .join("");
};

const externalRows = (site: Site): string => {
  const check = site.externalCheck;
  if (!check)
    return '<div class="empty">尚未运行外部检查。让 Agent 调用 <code>zeroy_inspect</code> 的 <code>externalCheck</code> 资源。</div>';
  const pages = asArray(check.pages);
  const pageSpeed = asRecord(check.pageSpeed);
  return `<div class="check-summary"><span>检查于 ${esc(string(check.checkedAt))}</span><span>PageSpeed：${esc(string(pageSpeed?.state))}${typeof pageSpeed?.score === "number" ? ` · ${esc(number(pageSpeed.score))}` : ""}</span></div><div class="check-list">${pages
    .map((value) => {
      const page = asRecord(value);
      if (!page) return "";
      const failures = asArray(page.brokenLinks).length;
      const subject =
        typeof page.locale === "string" && typeof page.objectId === "number"
          ? `${page.locale} · #${page.objectId}`
          : "requested URL";
      return `<div><a href="${esc(string(page.url))}" target="_blank" rel="noreferrer">${esc(subject)} ↗</a><span class="${page.status === 200 ? "healthy" : "unhealthy"}">${esc(number(page.status, "failed"))}</span><span>${page.canonical ? "canonical" : "no canonical"}</span><span>${asArray(page.hreflang).length} hreflang</span><span>${failures} broken links</span></div>`;
    })
    .join("")}</div>`;
};

const integrityRows = (site: Site): string => {
  const integrity = site.integrity;
  if (!integrity) return '<div class="empty">没有 integrity projection。</div>';
  const issues = asArray(integrity.issues);
  if (issues.length === 0)
    return '<div class="healthy-note">Connector internal integrity checks passed.</div>';
  return `<div class="issues">${issues
    .map((value) => {
      const issue = asRecord(value);
      return `<div><code>${esc(string(issue?.code))}</code><span>${esc(string(issue?.message))}</span></div>`;
    })
    .join("")}</div>`;
};

const siteReleaseRows = (site: Site): string => {
  const state = site.siteRelease;
  const active = site.activeRelease;
  const proof = asRecord(asRecord(active?.diagnostics)?.proof);
  const themeProof = asRecord(proof?.themeProof);
  const runtimeChecks = asRecord(themeProof?.runtimeChecks);
  const declared = asArray(runtimeChecks?.declaredScenarios).length;
  const executed = asArray(runtimeChecks?.executedScenarios).length;
  const capabilities = asArray(asRecord(site.activeSiteLogic?.artifactContract)?.provides)
    .map((value) => {
      const capability = asRecord(value);
      if (!capability) return "";
      return `<div><code>${esc(string(capability.capability))}@${esc(string(capability.version))}</code><span>${esc(string(capability.kind))} · ${esc(asArray(capability.effects).map(display).join(", "))}</span></div>`;
    })
    .join("");
  const migrations = asArray(site.migrationHistory?.migrations)
    .map((value) => {
      const migration = asRecord(value);
      return migration
        ? `<div><code>${esc(string(migration.idempotencyKey))}</code><span>epoch ${esc(number(migration.fromEpoch))} → ${esc(number(migration.toEpoch))} · ${esc(string(migration.appliedAt))}</span></div>`
        : "";
    })
    .join("");
  const history = asArray(site.releases?.releases)
    .slice(0, 6)
    .map((value) => {
      const release = asRecord(value);
      const proof = asRecord(asRecord(release?.diagnostics)?.proof);
      const blocking = asArray(proof?.blockingFailures).length;
      return release
        ? `<div class="inventory-row"><div class="object"><b>${esc(string(release.state))}</b><span><code>${esc(string(release.releaseId).slice(0, 18))}</code> · ${esc(string(release.createdAt))}</span></div><div class="locale-states"><span class="locale-state ${esc(string(release.state))}"><b>${esc(String(blocking))} blocking</b><small>epoch ${esc(number(release.storageEpoch))}</small></span></div></div>`
        : "";
    })
    .join("");
  return `<div class="facts"><div><span>Active release</span><code>${esc(string(state?.activeReleaseId).slice(0, 18))}</code></div><div><span>Theme Artifact</span><code>${esc(string(state?.themeArtifactId).slice(0, 18))}</code></div><div><span>SiteLogic Artifact</span><code>${esc(string(state?.siteLogicArtifactId).slice(0, 18))}</code></div><div><span>Storage epoch</span><b>${esc(number(state?.storageEpoch))}</b></div></div><div class="facts"><div><span>Source commit</span><code>${esc(string(asRecord(active?.provenance)?.sourceCommit).slice(0, 18))}</code></div><div><span>Theme contract</span><code>${esc(string(active?.themeContractHash).slice(0, 18))}</code></div><div><span>Logic contract</span><code>${esc(string(active?.siteLogicContractHash).slice(0, 18))}</code></div><div><span>Verification</span><b>${esc(String(executed))}/${esc(String(declared))} scenarios · ${esc(String(asArray(proof?.blockingFailures).length))} blocking</b></div></div><div class="two-column"><div><div class="subhead"><b>SiteLogic capabilities</b><span>active Artifact</span></div><div class="check-list">${capabilities || '<div class="empty">No public SiteLogic capabilities.</div>'}</div></div><div><div class="subhead"><b>Storage migrations</b><span>applied ledger</span></div><div class="check-list">${migrations || '<div class="empty">No storage migrations.</div>'}</div></div></div>${history || '<div class="empty">尚无 release history。</div>'}`;
};

const checkoutRows = (site: Site): string => {
  if (site.checkouts.length === 0) return '<div class="empty">此设备上还没有本地 checkout。</div>';
  return site.checkouts
    .map(
      (checkout) =>
        `<div class="inventory-row"><div class="object"><b>${esc(string(checkout.checkoutId).slice(0, 12))}</b><span><code>${esc(string(checkout.head).slice(0, 12))}</code> · ${esc(string(checkout.localPath))}</span></div><div class="locale-states"><span class="locale-state ${checkout.dirty === true ? "content-stale" : "published"}"><b>${checkout.dirty === true ? "dirty" : "clean"}</b><small>${esc(string(checkout.baseReleaseId).slice(0, 20))}</small></span></div></div>`,
    )
    .join("");
};

const siteCard = (site: Site): string => {
  const theme = asRecord(site.site?.activeTheme);
  const schema = asRecord(site.site?.themeSchema);
  if (site.state === "failed") {
    return `<section class="site-card failed"><header><div><h2>${esc(site.label)}</h2><p>${esc(site.endpoint)}</p></div><span class="status">连接失败</span></header><div class="error">${esc(site.error)}</div></section>`;
  }
  return `<section class="site-card"><header><div><div class="eyebrow">${esc(site.siteId)}</div><h2>${esc(site.label)}</h2><p>${esc(site.endpoint)}</p></div><span class="status ready">已连接</span></header><div class="facts"><div><span>Runtime</span><b>${esc(string(site.site?.runtimeVersion))}</b></div><div><span>Shell</span><b>${esc(string(theme?.name))}</b></div><div><span>Contract hash</span><code>${esc(string(schema?.contractHash).slice(0, 12))}</code></div><div><span>Schema</span><b>${esc(string(schema?.deploymentState, schema?.valid === true ? "active" : "invalid"))}</b></div></div><section class="block"><div class="block-head"><h3>Site release</h3><span>Theme × SiteLogic · read-only</span></div>${siteReleaseRows(site)}</section><section class="block"><div class="block-head"><h3>Local checkouts</h3><span>this device only</span></div>${checkoutRows(site)}</section><section class="block"><div class="block-head"><h3>语言</h3><span>WordPress SiteConfig</span></div><div class="chips">${localeChips(site)}</div></section><section class="block"><div class="block-head"><h3>语言覆盖</h3><span>missing · stale · review · recent publish</span></div>${translationCoverageRows(site)}</section><section class="block"><div class="block-head"><h3>ThemeSchema</h3><span>documents · collections · active Artifact</span></div>${schemaRows(site)}</section><section class="block"><div class="block-head"><h3>Canonical pages</h3><span>LocaleHead 状态与 route</span></div><div class="inventory">${inventoryRows(site)}</div></section><section class="block two-column"><div><div class="block-head"><h3>Shared ACF</h3><span>read-only</span></div>${acfRows(site)}</div><div><div class="block-head"><h3>Connector integrity</h3><span>read-only</span></div>${integrityRows(site)}</div></section><section class="block"><div class="block-head"><h3>前台检查</h3><span>HTTP · HTML · canonical · hreflang · links · PageSpeed</span></div>${externalRows(site)}</section></section>`;
};

const render = () => {
  const active = [...views.values()].sort((left, right) =>
    right.session.modified.localeCompare(left.session.modified),
  )[0];
  const known = [...sessions.values()].sort((left, right) =>
    right.modified.localeCompare(left.modified),
  );
  if (!active) {
    root.innerHTML = `<header class="top"><div><h1>zeroY Sites</h1><p>WordPress Runtime Connector · read-only operator view</p></div></header><main class="empty-page">${known.length ? "正在等待 zeroY Runtime projection…" : "创建一个已配置 ZEROY_SITES 的 Pipee 会话后，这里会显示站点投影。"}</main>`;
    return;
  }
  root.innerHTML = `<header class="top"><div><h1>zeroY Sites</h1><p>WordPress Runtime Connector · read-only operator view</p></div><div class="session"><span>Session</span><b>${esc(sessionName(active.session))}</b><small>${esc(active.view.observedAt)}</small></div></header><main class="content"><div class="notice">此页面只读：站点、ThemeSchema、ACF、页面语言状态和检查结果均来自当前 Connector projection。修改请在对话中让 Agent 执行。</div>${active.view.sites.map(siteCard).join("")}</main>`;
};

void connectWebSurfaceBrowser({
  sessions: (next) => {
    sessions.clear();
    for (const session of next) sessions.set(session.sessionId, session);
    render();
  },
  projection: (session, value) => {
    const view = asView(value);
    if (view) views.set(session.sessionId, { session, view });
    else views.delete(session.sessionId);
    render();
  },
  sessionClosed: (sessionId) => {
    sessions.delete(sessionId);
    views.delete(sessionId);
    render();
  },
  closed: () => {
    views.clear();
    render();
  },
});
