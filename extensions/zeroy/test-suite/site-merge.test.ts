import { describe, expect, it } from "vite-plus/test";
import { mergeJsonDocuments } from "../src/domain/site-merge.js";

describe("zeroY SiteCheckout three-way merge algebra", () => {
  it("merges independent field-path changes in one JSON document", () => {
    const base = { canonical: { title: "Old", body: "Old body" }, terms: [1] };
    const ours = { canonical: { title: "Ours", body: "Old body" }, terms: [1] };
    const remote = { canonical: { title: "Old", body: "Remote body" }, terms: [1] };

    expect(mergeJsonDocuments(base, ours, remote)).toEqual({
      value: {
        canonical: { body: "Remote body", title: "Ours" },
        terms: [1],
      },
      conflicts: [],
    });
  });

  it("reports the stable JSON pointer for competing edits", () => {
    expect(
      mergeJsonDocuments(
        { canonical: { title: "Old" } },
        { canonical: { title: "Ours" } },
        { canonical: { title: "Remote" } },
      ),
    ).toEqual({
      value: { canonical: { title: "Ours" } },
      conflicts: ["/canonical/title"],
    });
  });

  it("merges independent additions and deletions without shadow state", () => {
    expect(
      mergeJsonDocuments(
        { canonical: { title: "Old", obsolete: true } },
        { canonical: { title: "Old" } },
        { canonical: { title: "Old", obsolete: true, excerpt: "New" } },
      ),
    ).toEqual({
      value: { canonical: { excerpt: "New", title: "Old" } },
      conflicts: [],
    });
  });

  it("treats arrays as atomic semantic leaves", () => {
    expect(mergeJsonDocuments({ terms: [1] }, { terms: [1, 2] }, { terms: [1, 3] })).toEqual({
      value: { terms: [1, 2] },
      conflicts: ["/terms"],
    });
  });
});
