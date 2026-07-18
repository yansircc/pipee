import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const source = `abcdef123456${"a".repeat(28)}`;
const base = "b".repeat(40);
const message = `chore(release): release-abcdef123456

Release-Source: ${source}

Release-Base: ${base}

Release-Package: web 0.2.0 minor

Release-Package: chrome 0.2.0 minor`;

describe("independent package release record", () => {
  it("binds one source to the selected package versions", () => {
    const record = parseReleaseRecord(message);
    assert.deepEqual(record, {
      source,
      base,
      tag: "release-abcdef123456",
      packages: [
        { id: "web", version: "0.2.0", bump: "minor" },
        { id: "chrome", version: "0.2.0", bump: "minor" },
      ],
    });
    assert.deepEqual(
      assertReleaseRecordCommit({
        record,
        parents: [base, source],
        manifestVersions: { web: "0.2.0", loop: "0.5.7", chrome: "0.2.0" },
        sourceManifestVersions: { web: "0.1.9", loop: "0.5.7", chrome: "0.1.9" },
        packageIds: ["web", "loop", "chrome"],
      }),
      record,
    );
  });

  it("does not classify ordinary source commits or changesets as release records", () => {
    assert.equal(parseReleaseRecord("feat: add runtime"), undefined);
    assert.equal(
      parseReleaseRecord("feat: add runtime\n\nRelease-Package: web 0.2.0 minor"),
      undefined,
    );
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
      () => parseReleaseRecord(message.replace("Release-Package: chrome", "Release-Package: web")),
      /repeats/,
    );
    const record = parseReleaseRecord(message);
    assert.throws(
      () =>
        assertReleaseRecordCommit({
          record,
          parents: [base],
          manifestVersions: { web: "0.2.0", chrome: "0.2.0" },
          sourceManifestVersions: { web: "0.1.9", chrome: "0.1.9" },
          packageIds: ["web", "chrome"],
        }),
      /parents must be/,
    );
    assert.throws(
      () =>
        assertReleaseRecordCommit({
          record,
          parents: [base, source],
          manifestVersions: { web: "0.1.9", chrome: "0.2.0" },
          sourceManifestVersions: { web: "0.1.9", chrome: "0.1.9" },
          packageIds: ["web", "chrome"],
        }),
      /web manifest/,
    );
  });
});
