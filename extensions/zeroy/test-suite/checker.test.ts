import { describe, expect, it } from "vite-plus/test";
import { sameOriginExternalCheckUrls } from "../src/domain/checker.js";

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
