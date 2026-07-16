import { describe, expect, it } from "vite-plus/test";
import { bumpVersion, releaseBumpFromMessage } from "../scripts/release/version.mjs";

describe("release version algebra", () => {
  it("defaults each push to a patch release", () => {
    expect(releaseBumpFromMessage("fix: repair server")).toBe("patch");
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
  });

  it("uses an explicit minor trailer", () => {
    expect(releaseBumpFromMessage("feat: add mode\n\nRelease-Bump: minor")).toBe("minor");
    expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
  });

  it("uses an explicit major trailer", () => {
    expect(releaseBumpFromMessage("feat!: replace API\n\nRelease-Bump: major")).toBe("major");
    expect(bumpVersion("0.1.0", "major")).toBe("1.0.0");
  });

  it("rejects ambiguous or invalid bump declarations", () => {
    expect(() => releaseBumpFromMessage("Release-Bump: minor\nRelease-Bump: patch")).toThrow(
      "more than one",
    );
    expect(() => releaseBumpFromMessage("Release-Bump: feature")).toThrow("major, minor, or patch");
  });

  it("rejects versions outside the release state space", () => {
    expect(() => bumpVersion("0.1.0-beta.1", "patch")).toThrow("strict SemVer");
  });
});
