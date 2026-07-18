import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";
import connectorAuth from "../../src/protocol/connector-auth.json" with { type: "json" };
import sourceManifest from "../../src/browser/manifest.json" with { type: "json" };
import {
  SNAPSHOT_BUNDLE_PATH,
  TARGET_BOOTSTRAP_DOCUMENT_PATH,
} from "../../src/browser/extension-runtime-assets.js";
import {
  EXTENSION_PACKAGE_ID,
  extensionPackageIdFromPublicKey,
} from "../../src/pi/extension-package.js";
import {
  EXTENSION_BUILD_GRAPH,
  type ExtensionBuildGraph,
  artifactEntries,
  bundleEntries,
  expectedExtensionOutputs,
  htmlDocumentIds,
  renderExtensionDocument,
  renderExtensionManifest,
  validateBuildGraph,
  validateChromeExtensionVersion,
  validateExtensionDirectory,
} from "../../scripts/extension-build-graph.js";

const root = process.cwd();
const manifestInputs = {
  version: "1.2.3",
  publicKey: connectorAuth.extensionPublicKey,
  protocolFingerprint: "a".repeat(64),
};

const withExtensionFixture = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-build-graph-"));
  try {
    const documents = htmlDocumentIds();
    for (const [id, artifact] of artifactEntries()) {
      const output = join(directory, artifact.output);
      await mkdir(dirname(output), { recursive: true });
      if (artifact.kind === "bundle")
        await writeFile(
          output,
          `(() => ${JSON.stringify(manifestInputs.protocolFingerprint)})();\n`,
        );
      else if (artifact.kind === "generated") {
        await writeFile(
          output,
          JSON.stringify({
            extensionId: EXTENSION_PACKAGE_ID,
            displayVersion: manifestInputs.version,
            protocolFingerprint: manifestInputs.protocolFingerprint,
          }),
        );
      } else {
        const source = await readFile(join(root, artifact.source), "utf8");
        await writeFile(output, documents.has(id) ? renderExtensionDocument(id, source) : source);
      }
    }
    const manifest = renderExtensionManifest(sourceManifest, manifestInputs);
    await writeFile(
      join(directory, EXTENSION_BUILD_GRAPH.manifest.output),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

it("derives every extension output and manifest entry from one build graph", () => {
  validateBuildGraph();
  expect(
    Object.fromEntries(
      bundleEntries().map(([id, artifact]) => [id, [artifact.source, artifact.output]]),
    ),
  ).toEqual({
    serviceWorker: ["src/browser/service-worker.ts", "service-worker.js"],
    snapshot: ["src/browser/injected/snapshot.ts", SNAPSHOT_BUNDLE_PATH],
    popupScript: ["src/browser/popup.ts", "popup.js"],
  });
  expect([...expectedExtensionOutputs()].sort()).toEqual([
    "evidence.json",
    "manifest.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "service-worker.js",
    SNAPSHOT_BUNDLE_PATH,
    TARGET_BOOTSTRAP_DOCUMENT_PATH,
  ]);

  expect(sourceManifest).not.toHaveProperty("key");
  expect(sourceManifest).not.toHaveProperty("version");
  expect(sourceManifest).not.toHaveProperty("minimum_chrome_version");
  expect(sourceManifest).not.toHaveProperty("background.service_worker");
  expect(sourceManifest).not.toHaveProperty("action.default_popup");
  expect(sourceManifest.permissions).toEqual([
    "tabs",
    "tabGroups",
    "scripting",
    "storage",
    "unlimitedStorage",
    "alarms",
    "debugger",
  ]);
  expect(sourceManifest.externally_connectable).toEqual({
    matches: ["http://localhost/*", "http://127.0.0.1/*"],
  });
  const manifest = renderExtensionManifest(sourceManifest, manifestInputs);
  expect(manifest).toMatchObject({
    key: manifestInputs.publicKey,
    version: manifestInputs.version,
    minimum_chrome_version: String(EXTENSION_BUILD_GRAPH.minimumChromeVersion),
    background: { service_worker: "service-worker.js" },
    action: { default_popup: "popup.html" },
    externally_connectable: {
      matches: ["http://localhost/*", "http://127.0.0.1/*"],
    },
  });
  expect(extensionPackageIdFromPublicKey(String(manifest.key))).toBe(EXTENSION_PACKAGE_ID);
});

it("derives the browser syntax target and manifest floor from one graph value", () => {
  expect(EXTENSION_BUILD_GRAPH.minimumChromeVersion).toBe(120);
  expect(() => validateBuildGraph({ ...EXTENSION_BUILD_GRAPH, minimumChromeVersion: 0 })).toThrow(
    "positive integer",
  );
});

it("rejects a manifest key that is not an RSA SPKI public key", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const encodedKey = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString(
    "base64",
  );
  expect(() =>
    renderExtensionManifest(sourceManifest, { ...manifestInputs, publicKey: encodedKey }),
  ).toThrow("Chrome extension public key must be RSA");
});

it.each(["1.2.3-beta.1", "1.2.3+build", "1.02.3", "1.65536.0", "0.0.0", "1.2.3.4.5"])(
  "rejects package version %s before emitting a Chrome manifest",
  (version) => {
    expect(() => validateChromeExtensionVersion(version)).toThrow(
      "is not a Chrome numeric extension version",
    );
    expect(() => renderExtensionManifest(sourceManifest, { ...manifestInputs, version })).toThrow(
      "is not a Chrome numeric extension version",
    );
  },
);

it.each(["1", "0.16.0", "1.2.3.4", "65535.0.0"])(
  "accepts Chrome numeric package version %s",
  (version) => {
    expect(() => validateChromeExtensionVersion(version)).not.toThrow();
  },
);

it("renders popup asset filenames only from the build graph", async () => {
  const source = await readFile(join(root, "src/browser/popup.html"), "utf8");
  expect(source).not.toContain("popup.css");
  expect(source).not.toContain("popup.js");
  const renamedGraph = {
    ...EXTENSION_BUILD_GRAPH,
    artifacts: {
      ...EXTENSION_BUILD_GRAPH.artifacts,
      popupScript: {
        ...EXTENSION_BUILD_GRAPH.artifacts.popupScript,
        output: "assets/popup-runtime.js",
      },
      popupStyles: {
        ...EXTENSION_BUILD_GRAPH.artifacts.popupStyles,
        output: "assets/popup-theme.css",
      },
    },
  } satisfies ExtensionBuildGraph;

  const rendered = renderExtensionDocument("popupDocument", source, renamedGraph);
  expect(rendered).toContain('href="assets/popup-theme.css"');
  expect(rendered).toContain('src="assets/popup-runtime.js"');
});

it.each(["../snapshot.js", "assets\\snapshot.js"])(
  "rejects a non-extension output path %s",
  (output) => {
    const graph = {
      ...EXTENSION_BUILD_GRAPH,
      artifacts: {
        ...EXTENSION_BUILD_GRAPH.artifacts,
        snapshot: { ...EXTENSION_BUILD_GRAPH.artifacts.snapshot, output },
      },
    } satisfies ExtensionBuildGraph;

    expect(() => validateBuildGraph(graph)).toThrow("Extension output must be a relative path");
  },
);

it("accepts exactly the declared extension graph", () =>
  withExtensionFixture((directory) =>
    expect(validateExtensionDirectory(directory, manifestInputs)).resolves.toBeUndefined(),
  ));

it("rejects missing and undeclared build outputs", async () => {
  await withExtensionFixture(async (directory) => {
    await unlink(join(directory, SNAPSHOT_BUNDLE_PATH));
    await expect(validateExtensionDirectory(directory, manifestInputs)).rejects.toThrow(
      `missing=[${SNAPSHOT_BUNDLE_PATH}]`,
    );
  });
  await withExtensionFixture(async (directory) => {
    await writeFile(join(directory, "unexpected.js"), "");
    await expect(validateExtensionDirectory(directory, manifestInputs)).rejects.toThrow(
      "extra=[unexpected.js]",
    );
  });
});

it("rejects manifest and HTML references that diverge from the graph", async () => {
  await withExtensionFixture(async (directory) => {
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      action: { default_popup: string };
    };
    manifest.action.default_popup = "other.html";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(validateExtensionDirectory(directory, manifestInputs)).rejects.toThrow(
      "default_popup diverges",
    );
  });
  await withExtensionFixture(async (directory) => {
    const popupPath = join(directory, "popup.html");
    const popup = await readFile(popupPath, "utf8");
    await writeFile(popupPath, popup.replace("popup.css", "undeclared.css"));
    await expect(validateExtensionDirectory(directory, manifestInputs)).rejects.toThrow(
      "HTML asset graph mismatch",
    );
  });
});
