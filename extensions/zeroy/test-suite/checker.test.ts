import { describe, expect, it } from "vite-plus/test";
import { externalCheckProjection, sameOriginExternalCheckUrls } from "../src/domain/checker.js";

describe("zeroY external check boundary", () => {
  it("normalizes only same-origin operator-requested URLs", () => {
    expect(
      sameOriginExternalCheckUrls("https://site.example", ["https://site.example/draft?token=one"]),
    ).toEqual(["https://site.example/draft?token=one"]);
  });

  it("rejects malformed and cross-origin URLs before fetch", () => {
    expect(sameOriginExternalCheckUrls("https://site.example", ["not-a-url"])).toMatchObject({
      code: "zeroy_external_check_url_invalid",
    });
    expect(
      sameOriginExternalCheckUrls("https://site.example", ["https://other.example/"]),
    ).toMatchObject({
      code: "zeroy_external_check_url_origin_invalid",
    });
  });
});

describe("externalCheckProjection", () => {
  const page = (overrides = {}) => ({
    scenarioId: "home-en",
    routeKind: "front-page",
    objectId: 1,
    locale: "en",
    url: "https://site.example/",
    expectedStatus: 200,
    finalUrl: "https://site.example/",
    status: 200,
    title: "Home",
    description: null,
    h1: "Home",
    canonical: "https://site.example/",
    hreflang: ["en"],
    checkedLinks: 2,
    brokenLinks: [],
    error: null,
    ...overrides,
  });
  const check = {
    checkedAt: 1,
    pages: [page(), page({ scenarioId: "missing", routeKind: "not-found", status: 500 })],
    pageSpeed: { state: "not-configured", score: null, message: null },
  } as const;

  it("returns a constant-size default summary", () => {
    expect(externalCheckProjection(check)).toMatchObject({
      contract: "zeroy/external-check-summary@1",
      pageCount: 2,
      failureCount: 1,
      brokenLinkCount: 0,
      routeKinds: ["front-page", "not-found"],
    });
  });

  it("paginates compact page evidence", () => {
    expect(externalCheckProjection(check, "pages", 1)).toMatchObject({
      contract: "zeroy/external-check-pages@1",
      items: [{ scenarioId: "home-en", brokenLinkCount: 0 }],
      nextCursor: "1",
      hasMore: true,
    });
    expect(externalCheckProjection(check, "failures", 10)).toMatchObject({
      contract: "zeroy/external-check-failures@1",
      items: [{ scenarioId: "missing", status: 500 }],
      nextCursor: null,
      hasMore: false,
    });
  });
});
