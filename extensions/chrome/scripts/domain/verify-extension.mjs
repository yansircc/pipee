import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import connectorAuth from "../../src/protocol/connector-auth.json" with { type: "json" };
import { validateExtensionDirectory } from "../extension-build-graph.ts";

const packageRootInput = process.env.PI_EXTENSION_PACKAGE_ROOT ?? process.argv[2];
assert.ok(packageRootInput, "pi:domain-check requires the raw package root");
const packageRoot = resolve(packageRootInput);
const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const webDocument = await readFile(resolve(packageRoot, "dist", "web", "index.html"), "utf8");
const evidence = JSON.parse(
  await readFile(resolve(packageRoot, "dist", "browser-extension", "evidence.json"), "utf8"),
);
assert.equal(typeof manifest.version, "string", "archive package version must be a string");
assert.equal(manifest.piSuite.web.contract, "pi-suite/web-surface@1");
assert.match(webDocument, /<script[^>]+type="module"/);

await validateExtensionDirectory(resolve(packageRoot, "dist", "browser-extension"), {
  version: manifest.version,
  publicKey: connectorAuth.extensionPublicKey,
  protocolFingerprint: evidence.protocolFingerprint,
});

process.stdout.write(`${JSON.stringify({ browserExtension: true, version: manifest.version })}\n`);
