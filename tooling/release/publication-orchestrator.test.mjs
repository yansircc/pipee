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

it("reuses exact packages and publishes only missing packages", () => {
  const published = [];
  const result = publishCandidateSet({
    artifacts: [web, loop],
    lookup: ({ name }) =>
      name === web.name ? { _tag: "Present", integrity: web.integrity } : { _tag: "Missing" },
    publish: ({ name }) => published.push(name),
  });

  assert.deepEqual(published, [loop.name]);
  assert.deepEqual(result, [
    { name: web.name, decision: "Reuse" },
    { name: loop.name, decision: "Publish" },
  ]);
});

it("does not make publication depend on immediate registry propagation", () => {
  let lookups = 0;
  const published = [];

  publishCandidateSet({
    artifacts: [web],
    lookup: () => {
      lookups += 1;
      return { _tag: "Missing" };
    },
    publish: ({ name }) => published.push(name),
  });

  assert.equal(lookups, 1);
  assert.deepEqual(published, [web.name]);
});
