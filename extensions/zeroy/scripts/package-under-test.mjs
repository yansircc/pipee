import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Builds the exact npm archive that would be published, then exposes only its
 * extracted package root to an acceptance harness.  This keeps test fixtures
 * in the harness while forcing both the Pi extension and WordPress plugin to
 * come from the same production artifact.
 */
export const packageUnderTest = (projectRoot) => {
  const temporary = mkdtempSync(join(tmpdir(), "zeroy-package-under-test-"));
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.equal(packed.length, 1, "npm pack must produce exactly one zeroY archive.");
    const filename = packed[0]?.filename;
    assert.equal(typeof filename, "string", "npm pack did not name the zeroY archive.");
    const archive = resolve(temporary, filename);
    assert.ok(existsSync(archive), "npm pack did not write the zeroY archive.");

    const extracted = resolve(temporary, "extracted");
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packageRoot = resolve(extracted, "package");
    for (const path of ["package.json", "dist/pi/extension.js", "wordpress-plugin"]) {
      assert.ok(
        existsSync(resolve(packageRoot, path)),
        `Published zeroY archive is missing ${path}.`,
      );
    }
    return {
      archive,
      packageRoot,
      cleanup: () => rmSync(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
};
