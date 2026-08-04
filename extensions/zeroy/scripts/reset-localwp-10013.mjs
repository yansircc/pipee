import assert from "node:assert/strict";
import { prepareLocalwpFixture } from "./localwp-fixture.mjs";

// This is intentionally not a generic reset command. It is the reviewed,
// user-authorized destructive fixture reset for the disposable zeroY demo.
const port = process.env.ZEROY_LOCALWP_PORT ?? "10013";
assert.equal(port, "10013", "This destructive reset is restricted to LocalWP 10013.");

process.stdout.write(`${JSON.stringify(prepareLocalwpFixture(port))}\n`);
