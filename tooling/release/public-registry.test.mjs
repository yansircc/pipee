import assert from "node:assert/strict";
import { it } from "node:test";
import { waitForRegistrySet } from "./public-registry.mjs";

const web = {
  name: "@yansircc/pi-web",
  version: "0.2.0",
  integrity: "sha512-web",
};

it("retries missing registry versions until the exact archive is visible", async () => {
  let lookups = 0;
  let waits = 0;

  await waitForRegistrySet({
    artifacts: [web],
    lookup: () => {
      lookups += 1;
      return lookups < 3 ? { _tag: "Missing" } : { _tag: "Present", integrity: web.integrity };
    },
    wait: async () => {
      waits += 1;
    },
  });

  assert.equal(lookups, 3);
  assert.equal(waits, 2);
});

it("fails immediately when a public version has different bytes", async () => {
  let waits = 0;

  await assert.rejects(
    waitForRegistrySet({
      artifacts: [web],
      lookup: () => ({ _tag: "Present", integrity: "sha512-different" }),
      wait: async () => {
        waits += 1;
      },
    }),
    /integrity mismatch/,
  );
  assert.equal(waits, 0);
});

it("fails with every still-missing coordinate after the retry budget", async () => {
  const chrome = { ...web, name: "@yansircc/pi-chrome" };

  await assert.rejects(
    waitForRegistrySet({
      artifacts: [web, chrome],
      lookup: () => ({ _tag: "Missing" }),
      wait: async () => {},
      maxAttempts: 2,
    }),
    /@yansircc\/pi-web@0\.2\.0, @yansircc\/pi-chrome@0\.2\.0/,
  );
});
