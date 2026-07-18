import assert from "node:assert/strict";
import { it } from "node:test";
import { verifyPiReleaseTrain } from "./pi-release-train.mjs";

const coordinate = (name, version, peers = "") => `  '${name}@${version}${peers}':`;

const alignedLockfile = [
  coordinate("@earendil-works/pi-agent-core", "0.80.10"),
  coordinate("@earendil-works/pi-ai", "0.80.10"),
  coordinate("@earendil-works/pi-coding-agent", "0.80.10"),
  coordinate("@earendil-works/pi-tui", "0.80.10"),
].join("\n");

it("accepts one Pi release train version", () => {
  assert.equal(verifyPiReleaseTrain(alignedLockfile), "0.80.10");
});

it("rejects a split Pi release train", () => {
  assert.throws(
    () =>
      verifyPiReleaseTrain(
        `${alignedLockfile}\n${coordinate("@earendil-works/pi-ai", "0.80.11", "(zod@4.4.3)")}`,
      ),
    /pi-ai=0\.80\.10\|0\.80\.11/,
  );
});

it("rejects an incomplete Pi release train", () => {
  assert.throws(
    () => verifyPiReleaseTrain(alignedLockfile.replace(/^.*pi-tui.*$/m, "")),
    /missing runtime packages: @earendil-works\/pi-tui/,
  );
});
