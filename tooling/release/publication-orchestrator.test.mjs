import assert from "node:assert/strict";
import { it } from "node:test";
import { publishCandidateSet } from "./publication-orchestrator.mjs";

const artifact = (name, integrity) => ({ name, version: "0.6.0", integrity });
const web = artifact("@yansircc/pi-web", "sha512-web");
const loop = artifact("@yansircc/pi-loop", "sha512-loop");

it("preflights the whole Suite before the first irreversible publication", () => {
  const published = [];
  assert.throws(
    () =>
      publishCandidateSet({
        artifacts: [web, loop],
        lookup: ({ name }) =>
          name === web.name
            ? { _tag: "Missing" }
            : { _tag: "Present", integrity: "sha512-different" },
        publish: ({ name }) => published.push(name),
      }),
    /different bytes/,
  );
  assert.deepEqual(published, []);
});

it("reuses exact packages, publishes only missing packages, then proves all integrities", () => {
  const registry = new Map([[web.name, web.integrity]]);
  const published = [];
  const result = publishCandidateSet({
    artifacts: [web, loop],
    lookup: ({ name }) => {
      const integrity = registry.get(name);
      return integrity === undefined ? { _tag: "Missing" } : { _tag: "Present", integrity };
    },
    publish: ({ name, integrity }) => {
      published.push(name);
      registry.set(name, integrity);
    },
  });

  assert.deepEqual(published, [loop.name]);
  assert.deepEqual(result, [
    { name: web.name, decision: "Reuse" },
    { name: loop.name, decision: "Publish" },
  ]);
});
