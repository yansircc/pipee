import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const source = `abcdef123456${"a".repeat(28)}`;
const base = "b".repeat(40);
const message = `chore(release): release-abcdef123456

Release-Source: ${source}

Release-Base: ${base}

Release-Package: pipee 0.2.0 minor

Release-Package: chrome 0.2.0 minor`;

describe("independent package release record", () => {
  it("binds one source to the selected package versions", () => {
    const record = parseReleaseRecord(message);
    assert.deepEqual(record, {
      source,
      base,
      tag: "release-abcdef123456",
      packages: [
        { id: "pipee", version: "0.2.0", bump: "minor" },
        { id: "chrome", version: "0.2.0", bump: "minor" },
      ],
    });
    assert.deepEqual(
      assertReleaseRecordCommit({
        record,
        parents: [source],
        manifestVersions: { pipee: "0.2.0", loop: "0.5.7", chrome: "0.2.0" },
        sourceManifestVersions: { pipee: "0.1.9", loop: "0.5.7", chrome: "0.1.9" },
        packageIds: ["pipee", "loop", "chrome"],
      }),
      record,
    );
  });

  it("does not classify ordinary source commits or changesets as release records", () => {
    assert.equal(parseReleaseRecord("feat: add runtime"), undefined);
    assert.equal(
      parseReleaseRecord("feat: add runtime\n\nRelease-Package: pipee 0.2.0 minor"),
      undefined,
    );
  });

  it("allows the trusted main commit to be its own release source", () => {
    const same = "c".repeat(40);
    const record = parseReleaseRecord(
      message
        .replace("release-abcdef123456", "release-cccccccccccc")
        .replaceAll(source, same)
        .replace(base, same),
    );
    assert.equal(record.source, same);
    assert.equal(record.base, same);
  });

  it("rejects forged, partial, duplicate, and mismatched records", () => {
    assert.throws(
      () => parseReleaseRecord(`feat: forged\n\nRelease-Source: ${source}`),
      /non-canonical/,
    );
    assert.throws(
      () => parseReleaseRecord(message.replace("abcdef123456", "bbbbbbbbbbbb")),
      /does not match its source/,
    );
    assert.throws(
      () =>
        parseReleaseRecord(message.replace("Release-Package: chrome", "Release-Package: pipee")),
      /repeats/,
    );
    const record = parseReleaseRecord(message);
    assert.throws(
      () =>
        assertReleaseRecordCommit({
          record,
          parents: [base],
          manifestVersions: { pipee: "0.2.0", chrome: "0.2.0" },
          sourceManifestVersions: { pipee: "0.1.9", chrome: "0.1.9" },
          packageIds: ["pipee", "chrome"],
        }),
      /parent must be/,
    );
    assert.throws(
      () =>
        assertReleaseRecordCommit({
          record,
          parents: [base, source],
          manifestVersions: { pipee: "0.2.0", chrome: "0.2.0" },
          sourceManifestVersions: { pipee: "0.1.9", chrome: "0.1.9" },
          packageIds: ["pipee", "chrome"],
        }),
      /parent must be/,
    );
    assert.throws(
      () =>
        assertReleaseRecordCommit({
          record,
          parents: [source],
          manifestVersions: { pipee: "0.1.9", chrome: "0.2.0" },
          sourceManifestVersions: { pipee: "0.1.9", chrome: "0.1.9" },
          packageIds: ["pipee", "chrome"],
        }),
      /pipee manifest/,
    );
  });
});
