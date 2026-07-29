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
  return Object.entries(schemas)
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
          return `<span class="locale-state ${esc(state)}"><b>${route}</b><small>${esc(state)}${locale.revision !== undefined ? ` · r${esc(number(locale.revision))}` : ""}</small></span>`;
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
      return `<div><a href="${esc(string(page.url))}" target="_blank" rel="noreferrer">${esc(string(page.locale))} · #${esc(number(page.objectId))} ↗</a><span class="${page.status === 200 ? "healthy" : "unhealthy"}">${esc(number(page.status, "failed"))}</span><span>${page.canonical ? "canonical" : "no canonical"}</span><span>${asArray(page.hreflang).length} hreflang</span><span>${failures} broken links</span></div>`;
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

const siteCard = (site: Site): string => {
  const theme = asRecord(site.site?.activeTheme);
  const schema = asRecord(site.site?.themeSchema);
  if (site.state === "failed") {
    return `<section class="site-card failed"><header><div><h2>${esc(site.label)}</h2><p>${esc(site.endpoint)}</p></div><span class="status">连接失败</span></header><div class="error">${esc(site.error)}</div></section>`;
  }
  return `<section class="site-card"><header><div><div class="eyebrow">${esc(site.siteId)}</div><h2>${esc(site.label)}</h2><p>${esc(site.endpoint)}</p></div><span class="status ready">已连接</span></header><div class="facts"><div><span>Runtime</span><b>${esc(string(site.site?.runtimeVersion))}</b></div><div><span>Active theme</span><b>${esc(string(theme?.name))}</b></div><div><span>Contract hash</span><code>${esc(string(schema?.contractHash).slice(0, 12))}</code></div><div><span>Schema</span><b>${schema?.valid === true ? "valid" : "invalid"}</b></div></div><section class="block"><div class="block-head"><h3>语言</h3><span>WordPress SiteConfig</span></div><div class="chips">${localeChips(site)}</div></section><section class="block"><div class="block-head"><h3>ThemeSchema</h3><span>localized node contract</span></div>${schemaRows(site)}</section><section class="block"><div class="block-head"><h3>Canonical pages</h3><span>LocaleHead 状态与 route</span></div><div class="inventory">${inventoryRows(site)}</div></section><section class="block two-column"><div><div class="block-head"><h3>Shared ACF</h3><span>read-only</span></div>${acfRows(site)}</div><div><div class="block-head"><h3>Connector integrity</h3><span>read-only</span></div>${integrityRows(site)}</div></section><section class="block"><div class="block-head"><h3>前台检查</h3><span>HTTP · HTML · canonical · hreflang · links · PageSpeed</span></div>${externalRows(site)}</section></section>`;
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
