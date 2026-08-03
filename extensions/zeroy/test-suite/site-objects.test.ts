import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import fixture from "./fixtures/site-objects.json" with { type: "json" };
import {
  blobHash,
  canonicalJsonDocument,
  checkoutPathIsSafe,
  commitHash,
  pushRequestHash,
  treeHash,
  type SiteCommit,
} from "../src/domain/site-objects.js";

const blob = new TextEncoder().encode(fixture.blobText);
const blobId = blobHash(blob);
const entries = fixture.treeEntries.map((entry) => ({
  ...entry,
  kind: entry.kind as "blob" | "tree",
  mode: entry.mode as "file" | "executable",
  hash: entry.hash as `sha256:${string}`,
}));
const unwrap = <A>(
  result:
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly error: unknown },
): A => {
  expect(result._tag).toBe("Success");
  return (result as { readonly _tag: "Success"; readonly value: A }).value;
};
const tree = unwrap(treeHash(entries));
const commit: SiteCommit = { ...fixture.commit, tree, contract: "zeroy/site-commit@1" };

describe("zeroY SiteObject algebra", () => {
  it("uses stable type-separated identities", () => {
    expect(blobId).toBe(fixture.blobHash);
    expect(tree).toBe(fixture.treeHash);
    expect(unwrap(commitHash(commit))).toBe(fixture.commitHash);
    expect(unwrap(pushRequestHash(fixture.pushRequest))).toBe(fixture.pushRequestHash);
  });

  it.effect("normalizes JSON key order and platform newlines before blob creation", () =>
    canonicalJsonDocument('{"b":2,\r\n"a":1}').pipe(
      Effect.zip(canonicalJsonDocument('{"a":1,"b":2}\n')),
      Effect.map(([left, right]) => expect(left).toEqual(right)),
    ),
  );

  it("rejects paths that escape a checkout", () => {
    expect(checkoutPathIsSafe("artifacts/theme/index.php")).toBe(true);
    expect(checkoutPathIsSafe("../wp-config.php")).toBe(false);
    expect(checkoutPathIsSafe("artifacts//index.php")).toBe(false);
    const invalid = treeHash([{ name: "..", kind: "blob", hash: blobId, mode: "file" }]);
    expect(invalid._tag).toBe("Failure");
    if (invalid._tag === "Failure") {
      expect(invalid.error.code).toBe("tree_entry_invalid");
      expect(invalid.error.message).toBe("Unsafe tree entry: ..");
    }
  });
});
