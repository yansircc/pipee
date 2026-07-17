import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { root, suiteConfig } from "./lib.mjs";

const bumps = new Set(["major", "minor", "patch"]);
const bumpRank = new Map([
  ["patch", 0],
  ["minor", 1],
  ["major", 2],
]);

export const releaseChangesDirectory = "release/changes";

const readChange = (file) => {
  const value = JSON.parse(readFileSync(resolve(root, file), "utf8"));
  return { file, value };
};

export const releasePlanFromDocuments = (config, documents) => {
  assert.equal(
    new Set(documents.map(({ file }) => file)).size,
    documents.length,
    "release plan repeats a change file",
  );
  const packagesByName = new Map(config.packages.map((entry) => [entry.name, entry]));
  const requested = new Map();
  for (const { file, value } of documents) {
    assert.match(
      file,
      /^release\/changes\/[a-z0-9][a-z0-9-]*\.json$/,
      `invalid release changeset path ${file}`,
    );
    assert.equal(value.schemaVersion, 1, `${file} has an unsupported schema`);
    assert.ok(Array.isArray(value.changes) && value.changes.length > 0, `${file} has no changes`);
    for (const change of value.changes) {
      assert.deepEqual(
        Object.keys(change).sort(),
        ["bump", "package"],
        `${file} change must contain only package and bump`,
      );
      const entry = packagesByName.get(change.package);
      assert.ok(entry, `${file} names unknown public package ${String(change.package)}`);
      assert.ok(bumps.has(change.bump), `${file} has invalid bump ${String(change.bump)}`);
      const previous = requested.get(entry.id);
      if (previous === undefined || bumpRank.get(change.bump) > bumpRank.get(previous)) {
        requested.set(entry.id, change.bump);
      }
    }
  }

  return {
    files: documents.map(({ file }) => file),
    packages: config.packages.flatMap((entry) => {
      const bump = requested.get(entry.id);
      return bump === undefined ? [] : [{ ...entry, bump }];
    }),
  };
};

export const readReleasePlan = () => {
  const directory = resolve(root, releaseChangesDirectory);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => `${releaseChangesDirectory}/${file}`)
    : [];
  return releasePlanFromDocuments(suiteConfig(), files.map(readChange));
};

export const assertReleasePlan = (plan) => {
  assert.ok(Array.isArray(plan.files));
  assert.ok(Array.isArray(plan.packages));
  assert.equal(new Set(plan.files).size, plan.files.length, "release plan repeats a change file");
  assert.equal(
    new Set(plan.packages.map(({ id }) => id)).size,
    plan.packages.length,
    "release plan repeats a package",
  );
  return plan;
};
