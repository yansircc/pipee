import { Clock, Config, Data, Effect, Option, Redacted } from "effect";
import type { JsonRecord } from "./protocol.js";

export class ZeroYExternalCheckError extends Data.TaggedError("ZeroYExternalCheckError")<{
  readonly message: string;
}> {}

export type PageCheck = {
  readonly objectId: number | null;
  readonly locale: string | null;
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly h1: string | null;
  readonly canonical: string | null;
  readonly hreflang: ReadonlyArray<string>;
  readonly checkedLinks: number;
  readonly brokenLinks: ReadonlyArray<{ readonly url: string; readonly status: number | null }>;
  readonly error: string | null;
};

export type ExternalCheckTarget = {
  readonly objectId: number | null;
  readonly locale: string | null;
  readonly url: string;
};

export type ExternalCheckUrlError = {
  readonly code: "zeroy_external_check_url_invalid" | "zeroy_external_check_url_origin_invalid";
  readonly message: string;
};

export const sameOriginExternalCheckUrls = (
  endpoint: string,
  urls: ReadonlyArray<string>,
): ReadonlyArray<string> | ExternalCheckUrlError => {
  const origin = new URL(endpoint).origin;
  const checked: string[] = [];
  for (const raw of urls) {
    if (!URL.canParse(raw)) {
      return {
        code: "zeroy_external_check_url_invalid",
        message: "External checks require absolute same-origin URLs.",
      };
    }
    const url = new URL(raw);
    if (url.origin !== origin) {
      return {
        code: "zeroy_external_check_url_origin_invalid",
        message: "External checks may only load URLs from the configured zeroY site origin.",
      };
    }
    checked.push(url.href);
  }
  return checked;
};

export type ExternalCheck = {
  readonly checkedAt: number;
  readonly pages: ReadonlyArray<PageCheck>;
  readonly pageSpeed: {
    readonly state: "not-configured" | "ok" | "failed";
    readonly score: number | null;
    readonly message: string | null;
  };
};

type PageSpeedCheck = ExternalCheck["pageSpeed"];

const record = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const attribute = (markup: string, name: string): string | null => {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(markup);
  return match?.[1] ?? null;
};

const tag = (html: string, name: string): string | null => {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(html);
  return match
    ? match[1]!
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim() || null
    : null;
};

const meta = (html: string, name: string): string | null => {
  const candidates = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const candidate of candidates) {
    if (attribute(candidate, "name")?.toLowerCase() === name.toLowerCase())
      return attribute(candidate, "content");
  }
  return null;
};

const links = (html: string, base: URL): ReadonlyArray<string> => {
  const values = new Set<string>();
  for (const anchor of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attribute(anchor, "href");
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (URL.canParse(href, base.href)) {
      const url = new URL(href, base);
      if (url.origin === base.origin) values.add(url.href);
    }
    if (values.size >= 20) break;
  }
  return [...values];
};

const publishedPages = (inventory: JsonRecord): ReadonlyArray<ExternalCheckTarget> => {
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const pages: ExternalCheckTarget[] = [];
  for (const item of items) {
    const object = record(item);
    const objectId = object ? object.objectId : null;
    const locales = object && Array.isArray(object.locales) ? object.locales : [];
    if (typeof objectId !== "number") continue;
    for (const localeValue of locales) {
      const locale = record(localeValue);
      if (
        locale?.state !== "published" ||
        typeof locale.locale !== "string" ||
        typeof locale.url !== "string"
      )
        continue;
      pages.push({ objectId, locale: locale.locale, url: locale.url });
    }
  }
  return pages;
};

const fetchResponse = (
  url: string | URL,
  signal?: AbortSignal,
): Effect.Effect<Response, ZeroYExternalCheckError> =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        redirect: "follow",
        ...(signal === undefined ? {} : { signal }),
      }),
    catch: (cause) =>
      new ZeroYExternalCheckError({ message: `Could not fetch ${String(url)}: ${String(cause)}` }),
  });

const responseText = (response: Response): Effect.Effect<string, ZeroYExternalCheckError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new ZeroYExternalCheckError({ message: `Could not read page HTML: ${String(cause)}` }),
  });

const responseJson = (response: Response): Effect.Effect<unknown, ZeroYExternalCheckError> =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new ZeroYExternalCheckError({ message: `Could not read PageSpeed JSON: ${String(cause)}` }),
  });

const failedPage = (page: ExternalCheckTarget, error: ZeroYExternalCheckError): PageCheck => ({
  objectId: page.objectId,
  locale: page.locale,
  url: page.url,
  finalUrl: null,
  status: null,
  title: null,
  description: null,
  h1: null,
  canonical: null,
  hreflang: [],
  checkedLinks: 0,
  brokenLinks: [],
  error: error.message,
});

const checkPage = (
  page: ExternalCheckTarget,
  signal?: AbortSignal,
): Effect.Effect<PageCheck, never> =>
  Effect.gen(function* () {
    const response = yield* fetchResponse(page.url, signal);
    const html = yield* responseText(response);
    if (!URL.canParse(response.url)) {
      return yield* new ZeroYExternalCheckError({
        message: `Response has invalid URL ${response.url}.`,
      });
    }
    const base = new URL(response.url);
    const checkedUrls = links(html, base);
    const linkStatuses = yield* Effect.forEach(
      checkedUrls,
      (url) =>
        fetchResponse(url, signal).pipe(
          Effect.map((target) => (target.ok ? null : { url, status: target.status })),
          Effect.catch(() => Effect.succeed({ url, status: null })),
        ),
      { concurrency: 4 },
    );
    const alternateTags = html.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/gi) ?? [];
    return {
      objectId: page.objectId,
      locale: page.locale,
      url: page.url,
      finalUrl: response.url,
      status: response.status,
      title: tag(html, "title"),
      description: meta(html, "description"),
      h1: tag(html, "h1"),
      canonical:
        (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi) ?? [])
          .map((item) => attribute(item, "href"))
          .find((value) => value !== null) ?? null,
      hreflang: alternateTags
        .map((item) => attribute(item, "hreflang"))
        .filter((value): value is string => value !== null),
      checkedLinks: linkStatuses.length,
      brokenLinks: linkStatuses.filter(
        (value): value is { readonly url: string; readonly status: number | null } =>
          value !== null,
      ),
      error: null,
    } satisfies PageCheck;
  }).pipe(
    Effect.catch((error) => Effect.succeed(failedPage(page, error))),
    Effect.withSpan("zeroy.external-check.page", { attributes: { "http.url": page.url } }),
  );

const pageSpeed = (
  firstPage: string | undefined,
  signal?: AbortSignal,
): Effect.Effect<PageSpeedCheck, never> =>
  Config.option(Config.redacted("ZEROY_PAGESPEED_API_KEY")).pipe(
    Effect.flatMap((key): Effect.Effect<PageSpeedCheck, ZeroYExternalCheckError> => {
      if (firstPage === undefined || Option.isNone(key)) {
        return Effect.succeed({
          state: "not-configured",
          score: null,
          message: null,
        } satisfies PageSpeedCheck);
      }
      const url = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
      url.searchParams.set("url", firstPage);
      url.searchParams.set("strategy", "mobile");
      url.searchParams.set("key", Redacted.value(key.value));
      return fetchResponse(url, signal).pipe(
        Effect.flatMap((response) =>
          responseJson(response).pipe(
            Effect.map((raw) => {
              const payload = record(raw);
              const lighthouse = payload ? record(payload.lighthouseResult) : null;
              const categories = lighthouse ? record(lighthouse.categories) : null;
              const performance = categories ? record(categories.performance) : null;
              const score =
                typeof performance?.score === "number" ? Math.round(performance.score * 100) : null;
              return response.ok
                ? ({ state: "ok", score, message: null } satisfies PageSpeedCheck)
                : ({
                    state: "failed",
                    score: null,
                    message: `PageSpeed returned ${response.status}.`,
                  } satisfies PageSpeedCheck);
            }),
          ),
        ),
      );
    }),
    Effect.catch((error) =>
      Effect.succeed({
        state: "failed",
        score: null,
        message: errorMessage(error),
      } satisfies PageSpeedCheck),
    ),
    Effect.withSpan("zeroy.external-check.pagespeed"),
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const runExternalCheck = (
  inventory: JsonRecord,
  requestedUrls: ReadonlyArray<string> = [],
  signal?: AbortSignal,
): Effect.Effect<ExternalCheck, never> => {
  const pages = [
    ...publishedPages(inventory),
    ...requestedUrls.map((url) => ({ objectId: null, locale: null, url })),
  ].filter(
    (page, index, all) => all.findIndex((candidate) => candidate.url === page.url) === index,
  );
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((checkedAt) =>
      Effect.all(
        [
          Effect.forEach(pages, (page) => checkPage(page, signal), { concurrency: 4 }),
          pageSpeed(pages[0]?.url, signal),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([checkedPages, pageSpeedResult]) => ({
          checkedAt,
          pages: checkedPages,
          pageSpeed: pageSpeedResult,
        })),
      ),
    ),
    Effect.withSpan("zeroy.external-check.run", {
      attributes: { "zeroy.page_count": pages.length },
    }),
  );
};

export const externalCheckSummary = (check: ExternalCheck): string => {
  const failures = check.pages.filter((page) => page.status !== 200 || page.error !== null).length;
  const brokenLinks = check.pages.reduce((total, page) => total + page.brokenLinks.length, 0);
  return `${check.pages.length} page(s), ${failures} HTTP failure(s), ${brokenLinks} broken link(s)`;
};
