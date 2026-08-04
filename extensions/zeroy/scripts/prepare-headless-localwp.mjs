import assert from "node:assert/strict";
import { prepareLocalwpFixture } from "./localwp-fixture.mjs";

const port = process.env.ZEROY_LOCALWP_PORT ?? "10014";
assert.equal(port, "10014", "Destructive headless preparation is restricted to LocalWP 10014.");

process.stdout.write(`${JSON.stringify(prepareLocalwpFixture(port))}\n`);
