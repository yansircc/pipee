import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { root, run, suiteConfig } from "./lib.mjs";
import { waitForRegistrySet } from "./public-registry.mjs";
import { classifyRegistryLookup } from "./registry-state.mjs";

const candidate = JSON.parse(readFileSync(resolve(root, "release/candidate.json"), "utf8"));
assert.equal(candidate.releasable, true, "public acceptance requires a releasable candidate");

const packages = suiteConfig().packages.flatMap((entry) => {
  const artifact = candidate.artifacts[entry.id];
  if (!artifact) return [];
  return [
    {
      ...entry,
      version: artifact.version,
      coordinate: `${artifact.name}@${artifact.version}`,
      artifact,
    },
  ];
});
assert.ok(packages.length > 0, "public acceptance requires at least one selected package");

const registryIntegrity = (artifact) =>
  classifyRegistryLookup(
    spawnSync("npm", ["view", `${artifact.name}@${artifact.version}`, "dist.integrity", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

await waitForRegistrySet({
  artifacts: packages.map(({ artifact }) => artifact),
  lookup: registryIntegrity,
  wait: () => setTimeout(10_000),
});

const verifyConsumer = (consumer) => {
  const directory = mkdtempSync(join(tmpdir(), `pi-suite-public-${consumer}-`));
  try {
    writeFileSync(join(directory, "package.json"), '{"private":true}\n');
    if (consumer === "npm") {
      run("npm", ["install", "--ignore-scripts", ...packages.map(({ coordinate }) => coordinate)], {
        cwd: directory,
      });
    } else {
      writeFileSync(
        join(directory, "pnpm-workspace.yaml"),
        'allowBuilds:\n  "@google/genai": false\n  msgpackr-extract: false\n  protobufjs: false\n',
      );
      run("pnpm", ["add", "--ignore-scripts", ...packages.map(({ coordinate }) => coordinate)], {
        cwd: directory,
      });
    }

    for (const entry of packages) {
      const installed = JSON.parse(
        readFileSync(
          join(directory, "node_modules", ...entry.name.split("/"), "package.json"),
          "utf8",
        ),
      );
      assert.equal(
        installed.version,
        entry.version,
        `${consumer} installed the wrong ${entry.name}`,
      );
    }
    assert.equal(
      existsSync(
        join(directory, "node_modules", "@pipee", "companion-contracts", "package.json"),
      ),
      false,
      `${consumer} installed the private contracts package`,
    );
    if (packages.some(({ id }) => id === "web")) {
      const bin = process.platform === "win32" ? "pipee.cmd" : "pipee";
      assert.equal(
        existsSync(join(directory, "node_modules", ".bin", bin)),
        true,
        `${consumer} is missing pipee bin`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

verifyConsumer("npm");
verifyConsumer("pnpm");
process.stdout.write("Verified exact registry integrity and fresh npm/pnpm public consumers.\n");
