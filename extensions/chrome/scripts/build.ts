import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { build } from "vite-plus";
import { BRIDGE_HOST, BRIDGE_ORIGIN } from "../src/protocol/bridge-contract.ts";
import connectorAuth from "../src/protocol/connector-auth.json" with { type: "json" };
import { replaceDirectoryWithRollback } from "./directory-replacement.ts";
import {
  EXTENSION_BUILD_GRAPH,
  bundleEntries,
  htmlDocumentIds,
  renderExtensionManifest,
  renderExtensionDocument,
  staticEntries,
  validateBuildGraph,
  validateExtensionDirectory,
} from "./extension-build-graph.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arguments_ = process.argv.slice(2);
if (arguments_.length % 2 !== 0) {
  throw new Error("Build options must be --name value pairs");
}
type BuildOption = "--bridge-url" | "--out-dir";
const argumentsByName = new Map<BuildOption, string>();
for (let index = 0; index < arguments_.length; index += 2) {
  const name = arguments_[index];
  if (name !== "--bridge-url" && name !== "--out-dir") {
    throw new Error(`Unknown build option: ${name}`);
  }
  if (argumentsByName.has(name)) throw new Error(`Duplicate build option: ${name}`);
  const value = arguments_[index + 1];
  if (value === undefined) throw new Error(`Build option ${name} is missing its value`);
  argumentsByName.set(name, value);
}
const bridgeUrl = new URL(argumentsByName.get("--bridge-url") ?? BRIDGE_ORIGIN);
if (
  bridgeUrl.protocol !== "http:" ||
  bridgeUrl.hostname !== BRIDGE_HOST ||
  !bridgeUrl.port ||
  bridgeUrl.username ||
  bridgeUrl.password ||
  bridgeUrl.pathname !== "/" ||
  bridgeUrl.search ||
  bridgeUrl.hash
) {
  throw new Error(`--bridge-url must be an explicit http://${BRIDGE_HOST}:<port> origin`);
}
const explicitOutput = argumentsByName.get("--out-dir");
const packageJson: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (
  typeof packageJson !== "object" ||
  packageJson === null ||
  !("version" in packageJson) ||
  typeof packageJson.version !== "string" ||
  !("files" in packageJson) ||
  !Array.isArray(packageJson.files) ||
  packageJson.files.some((file) => typeof file !== "string")
) {
  throw new Error("package.json must declare a string version and published file paths");
}
const publishedFiles = packageJson.files as Array<string>;
const browserAsset = publishedFiles.filter((asset) => asset.endsWith("/browser-extension"));
const browserOutput = browserAsset[0];
if (browserAsset.length !== 1 || browserOutput === undefined) {
  throw new Error("Pi extension profile must declare exactly one browser-extension asset");
}
const output = resolve(root, explicitOutput ?? browserOutput);
const outputFromTemp = relative(resolve(tmpdir()), output);
if (
  explicitOutput &&
  (!outputFromTemp || outputFromTemp.startsWith("..") || isAbsolute(outputFromTemp))
) {
  throw new Error("Explicit --out-dir must be inside the operating-system temporary directory");
}
const sourceManifest: unknown = JSON.parse(
  await readFile(join(root, EXTENSION_BUILD_GRAPH.manifest.source), "utf8"),
);
const manifestInputs = {
  version: packageJson.version,
  publicKey: connectorAuth.extensionPublicKey,
};
validateBuildGraph();
const builtManifest = renderExtensionManifest(sourceManifest, manifestInputs);
const nodeSpecifiers = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);
const browserOnly: {
  readonly name: string;
  readonly resolveId: (source: string, importer?: string) => void;
} = {
  name: "browser-only",
  resolveId(source, importer) {
    if (nodeSpecifiers.has(source)) {
      throw new Error(`${importer ?? "Browser entry"} imports Node.js module ${source}`);
    }
  },
};

const prepareExtension = async (directory: string): Promise<void> => {
  for (const [id, bundle] of bundleEntries()) {
    await build({
      configFile: false,
      root,
      define: {
        __PI_CHROME_BRIDGE_URL__: JSON.stringify(bridgeUrl.origin),
      },
      plugins: [browserOnly],
      build: {
        emptyOutDir: false,
        minify: false,
        outDir: directory,
        sourcemap: false,
        target: `chrome${EXTENSION_BUILD_GRAPH.minimumChromeVersion}`,
        rolldownOptions: {
          input: {
            [id]: join(root, bundle.source),
          },
          output: {
            entryFileNames: bundle.output,
            format: "iife",
          },
        },
      },
    });
  }

  const manifestOutput = join(directory, EXTENSION_BUILD_GRAPH.manifest.output);
  await mkdir(dirname(manifestOutput), { recursive: true });
  await writeFile(manifestOutput, `${JSON.stringify(builtManifest, null, 2)}\n`);
  const documents = htmlDocumentIds();
  for (const [id, asset] of staticEntries()) {
    const output = join(directory, asset.output);
    await mkdir(dirname(output), { recursive: true });
    if (documents.has(id)) {
      const source = await readFile(join(root, asset.source), "utf8");
      await writeFile(output, renderExtensionDocument(id, source));
    } else {
      await copyFile(join(root, asset.source), output);
    }
  }
};

await replaceDirectoryWithRollback(output, {
  prepare: prepareExtension,
  validate: (directory) => validateExtensionDirectory(directory, manifestInputs),
});
