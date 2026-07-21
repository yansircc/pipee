import { readFile, readdir } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { Schema } from "effect";
import { ChromeExtensionExpectation } from "@pipee/companion-contracts/chrome";
import {
  SNAPSHOT_BUNDLE_PATH,
  TARGET_BOOTSTRAP_DOCUMENT_PATH,
} from "../src/browser/extension-runtime-assets.ts";
import { extensionPackageIdFromPublicKey } from "../src/pi/extension-package.ts";

export type ExtensionArtifact =
  | { readonly kind: "bundle"; readonly source: string; readonly output: string }
  | { readonly kind: "static"; readonly source: string; readonly output: string }
  | { readonly kind: "generated"; readonly output: string };

export type ExtensionBuildGraph = {
  readonly minimumChromeVersion: number;
  readonly manifest: {
    readonly source: string;
    readonly output: string;
    readonly serviceWorker: keyof ExtensionBuildGraph["artifacts"];
    readonly defaultPopup: keyof ExtensionBuildGraph["artifacts"];
  };
  readonly artifacts: Readonly<Record<string, ExtensionArtifact>>;
  readonly htmlReferences: Readonly<
    Record<string, { readonly document: string; readonly artifacts: ReadonlyArray<string> }>
  >;
};

export const EXTENSION_BUILD_GRAPH = {
  minimumChromeVersion: 120,
  manifest: {
    source: "src/browser/manifest.json",
    output: "manifest.json",
    serviceWorker: "serviceWorker",
    defaultPopup: "popupDocument",
  },
  artifacts: {
    serviceWorker: {
      kind: "bundle",
      source: "src/browser/service-worker.ts",
      output: "service-worker.js",
    },
    snapshot: {
      kind: "bundle",
      source: "src/browser/injected/snapshot.ts",
      output: SNAPSHOT_BUNDLE_PATH,
    },
    popupScript: {
      kind: "bundle",
      source: "src/browser/popup.ts",
      output: "popup.js",
    },
    popupDocument: {
      kind: "static",
      source: "src/browser/popup.html",
      output: "popup.html",
    },
    popupStyles: {
      kind: "static",
      source: "src/browser/popup.css",
      output: "popup.css",
    },
    targetBootstrapDocument: {
      kind: "static",
      source: "src/browser/target-bootstrap.html",
      output: TARGET_BOOTSTRAP_DOCUMENT_PATH,
    },
    evidence: {
      kind: "generated",
      output: "evidence.json",
    },
  },
  htmlReferences: {
    popup: {
      document: "popupDocument",
      artifacts: ["popupScript", "popupStyles"],
    },
  },
} as const satisfies ExtensionBuildGraph;

export type BuildManifestInputs = {
  readonly version: string;
  readonly publicKey: string;
  readonly protocolFingerprint: string;
};

export const validateChromeExtensionVersion = (version: string): void => {
  const components = version.split(".");
  const valid =
    components.length >= 1 &&
    components.length <= 4 &&
    components.every(
      (component) => /^(?:0|[1-9][0-9]*)$/.test(component) && Number(component) <= 65_535,
    ) &&
    components.some((component) => Number(component) > 0);
  if (!valid) {
    throw new Error(
      `Package version ${JSON.stringify(version)} is not a Chrome numeric extension version; use 1-4 dot-separated integers between 0 and 65535 with no prerelease or build suffix`,
    );
  }
};

type JsonObject = Record<string, unknown>;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asObject = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
};

export const artifactEntries = (graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH) =>
  Object.entries(graph.artifacts);

export const bundleEntries = (graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH) =>
  artifactEntries(graph).filter(
    (entry): entry is [string, Extract<ExtensionArtifact, { readonly kind: "bundle" }>] =>
      entry[1].kind === "bundle",
  );

export const staticEntries = (graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH) =>
  artifactEntries(graph).filter(
    (entry): entry is [string, Extract<ExtensionArtifact, { readonly kind: "static" }>] =>
      entry[1].kind === "static",
  );

export const htmlDocumentIds = (graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH) =>
  new Set(Object.values(graph.htmlReferences).map((reference) => reference.document));

export const expectedExtensionOutputs = (
  graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH,
): ReadonlySet<string> =>
  new Set([
    graph.manifest.output,
    ...artifactEntries(graph).map(([, artifact]) => artifact.output),
  ]);

const assertRelativeOutput = (output: string): void => {
  if (
    !output ||
    output === "." ||
    output === ".." ||
    output.startsWith("../") ||
    output.includes("\\") ||
    posix.isAbsolute(output) ||
    posix.normalize(output) !== output
  ) {
    throw new Error(`Extension output must be a relative path: ${output}`);
  }
};

export const validateBuildGraph = (graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH): void => {
  if (!Number.isInteger(graph.minimumChromeVersion) || graph.minimumChromeVersion <= 0) {
    throw new Error("Extension minimum Chrome version must be a positive integer");
  }
  const entries = artifactEntries(graph);
  const ids = new Set(entries.map(([id]) => id));
  const outputs = [graph.manifest.output, ...entries.map(([, artifact]) => artifact.output)];
  for (const output of outputs) assertRelativeOutput(output);
  if (new Set(outputs).size !== outputs.length) {
    throw new Error("Extension build graph contains duplicate outputs");
  }

  for (const id of [graph.manifest.serviceWorker, graph.manifest.defaultPopup]) {
    if (!ids.has(String(id)))
      throw new Error(`Manifest references unknown artifact: ${String(id)}`);
  }
  if (graph.artifacts[String(graph.manifest.serviceWorker)]?.kind !== "bundle") {
    throw new Error("Manifest service_worker must reference a bundle artifact");
  }
  if (graph.artifacts[String(graph.manifest.defaultPopup)]?.kind !== "static") {
    throw new Error("Manifest default_popup must reference a static artifact");
  }

  const htmlDocuments = new Set<string>();
  for (const reference of Object.values(graph.htmlReferences)) {
    if (htmlDocuments.has(reference.document)) {
      throw new Error(`HTML document has multiple graph entries: ${reference.document}`);
    }
    htmlDocuments.add(reference.document);
    const document = graph.artifacts[reference.document];
    if (!document || document.kind !== "static" || !document.output.endsWith(".html")) {
      throw new Error(`HTML reference document is invalid: ${reference.document}`);
    }
    if (new Set(reference.artifacts).size !== reference.artifacts.length) {
      throw new Error(`HTML document repeats an artifact: ${reference.document}`);
    }
    for (const artifact of reference.artifacts) {
      if (!ids.has(artifact)) throw new Error(`HTML references unknown artifact: ${artifact}`);
    }
  }
};

export const renderExtensionManifest = (
  source: unknown,
  inputs: BuildManifestInputs,
  graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH,
): JsonObject => {
  validateBuildGraph(graph);
  validateChromeExtensionVersion(inputs.version);
  extensionPackageIdFromPublicKey(inputs.publicKey);
  const manifest = asObject(source, "Source extension manifest");
  if (
    hasOwn(manifest, "key") ||
    hasOwn(manifest, "version") ||
    hasOwn(manifest, "minimum_chrome_version")
  ) {
    throw new Error(
      "Source extension manifest must not contain build-derived key, version, or minimum_chrome_version",
    );
  }
  const sourceBackground = manifest.background;
  const background =
    sourceBackground === undefined
      ? {}
      : { ...asObject(sourceBackground, "Source extension manifest background") };
  if (hasOwn(background, "service_worker")) {
    throw new Error("Source extension manifest service_worker is owned by the build graph");
  }
  const sourceAction = manifest.action;
  const action =
    sourceAction === undefined
      ? {}
      : { ...asObject(sourceAction, "Source extension manifest action") };
  if (hasOwn(action, "default_popup")) {
    throw new Error("Source extension manifest default_popup is owned by the build graph");
  }

  const serviceWorker = graph.artifacts[String(graph.manifest.serviceWorker)];
  const defaultPopup = graph.artifacts[String(graph.manifest.defaultPopup)];
  if (!serviceWorker || !defaultPopup)
    throw new Error("Build graph manifest artifacts are missing");
  return {
    ...manifest,
    key: inputs.publicKey,
    version: inputs.version,
    minimum_chrome_version: String(graph.minimumChromeVersion),
    background: { ...background, service_worker: serviceWorker.output },
    action: { ...action, default_popup: defaultPopup.output },
  };
};

const localHtmlReferences = (html: string): ReadonlySet<string> => {
  const references = new Set<string>();
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const reference = match[1];
    if (
      !reference ||
      reference.startsWith("#") ||
      reference.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(reference)
    ) {
      continue;
    }
    const pathname = reference.split(/[?#]/, 1)[0];
    if (pathname) references.add(posix.normalize(pathname));
  }
  return references;
};

export const renderExtensionDocument = (
  documentId: string,
  source: string,
  graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH,
): string => {
  validateBuildGraph(graph);
  const reference = Object.values(graph.htmlReferences).find(
    (candidate) => candidate.document === documentId,
  );
  if (!reference) throw new Error(`Artifact is not a declared HTML document: ${documentId}`);
  const document = graph.artifacts[documentId];
  if (!document) throw new Error(`HTML document artifact is missing: ${documentId}`);
  const expectedIds = new Set(reference.artifacts);
  const seenIds = new Set<string>();
  const rendered = source.replace(
    /\{\{extension-asset:([A-Za-z][A-Za-z0-9_-]*)\}\}/g,
    (_token, artifactId: string) => {
      if (!expectedIds.has(artifactId)) {
        throw new Error(`${document.output} contains undeclared asset token: ${artifactId}`);
      }
      if (seenIds.has(artifactId)) {
        throw new Error(`${document.output} contains duplicate asset token: ${artifactId}`);
      }
      seenIds.add(artifactId);
      const target = graph.artifacts[artifactId];
      if (!target) throw new Error(`HTML target artifact is missing: ${artifactId}`);
      return posix.relative(posix.dirname(document.output), target.output);
    },
  );
  const missingIds = [...expectedIds].filter((artifactId) => !seenIds.has(artifactId));
  if (missingIds.length > 0 || rendered.includes("{{extension-asset:")) {
    throw new Error(
      `${document.output} asset tokens do not match the build graph; missing=[${missingIds.join(", ")}]`,
    );
  }
  return rendered;
};

const addManifestPath = (references: Set<string>, value: unknown): void => {
  if (typeof value === "string") references.add(posix.normalize(value));
};

const addManifestPathRecord = (references: Set<string>, value: unknown): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  for (const path of Object.values(value)) addManifestPath(references, path);
};

const manifestAssetReferences = (manifestValue: unknown): ReadonlySet<string> => {
  const manifest = asObject(manifestValue, "Built extension manifest");
  const references = new Set<string>();
  const background = manifest.background;
  if (typeof background === "object" && background !== null && !Array.isArray(background)) {
    addManifestPath(references, "service_worker" in background ? background.service_worker : null);
  }
  const action = manifest.action;
  if (typeof action === "object" && action !== null && !Array.isArray(action)) {
    addManifestPath(references, "default_popup" in action ? action.default_popup : null);
    addManifestPathRecord(references, "default_icon" in action ? action.default_icon : null);
  }
  addManifestPathRecord(references, manifest.icons);
  addManifestPath(references, manifest.options_page);
  for (const field of ["devtools_page"] as const) addManifestPath(references, manifest[field]);

  const optionsUi = manifest.options_ui;
  if (typeof optionsUi === "object" && optionsUi !== null && !Array.isArray(optionsUi)) {
    addManifestPath(references, "page" in optionsUi ? optionsUi.page : null);
  }
  const sidePanel = manifest.side_panel;
  if (typeof sidePanel === "object" && sidePanel !== null && !Array.isArray(sidePanel)) {
    addManifestPath(references, "default_path" in sidePanel ? sidePanel.default_path : null);
  }
  addManifestPathRecord(references, manifest.chrome_url_overrides);

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  for (const contentScript of contentScripts) {
    if (typeof contentScript !== "object" || contentScript === null) continue;
    for (const field of ["js", "css"] as const) {
      const paths = field in contentScript ? contentScript[field] : null;
      if (Array.isArray(paths)) for (const path of paths) addManifestPath(references, path);
    }
  }
  const webResources = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  for (const resourceGroup of webResources) {
    if (typeof resourceGroup !== "object" || resourceGroup === null) continue;
    const resources = "resources" in resourceGroup ? resourceGroup.resources : null;
    if (Array.isArray(resources)) for (const path of resources) addManifestPath(references, path);
  }
  const sandbox = manifest.sandbox;
  if (typeof sandbox === "object" && sandbox !== null && !Array.isArray(sandbox)) {
    const pages = "pages" in sandbox ? sandbox.pages : null;
    if (Array.isArray(pages)) for (const path of pages) addManifestPath(references, path);
  }
  return references;
};

const listDirectoryFiles = async (directory: string, prefix = ""): Promise<Array<string>> => {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: Array<string> = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listDirectoryFiles(directory, path)));
    else files.push(path.split(sep).join("/"));
  }
  return files.sort();
};

const setDifference = (left: ReadonlySet<string>, right: ReadonlySet<string>): Array<string> =>
  [...left].filter((value) => !right.has(value)).sort();

export const validateExtensionDirectory = async (
  directory: string,
  inputs: BuildManifestInputs,
  graph: ExtensionBuildGraph = EXTENSION_BUILD_GRAPH,
): Promise<void> => {
  validateBuildGraph(graph);
  validateChromeExtensionVersion(inputs.version);
  const expectedExtensionId = extensionPackageIdFromPublicKey(inputs.publicKey);
  const expectedFiles = expectedExtensionOutputs(graph);
  const actualFiles = new Set(await listDirectoryFiles(directory));
  const missing = setDifference(expectedFiles, actualFiles);
  const extra = setDifference(actualFiles, expectedFiles);
  if (missing.length || extra.length) {
    throw new Error(
      `Extension output graph mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }

  for (const [id, bundle] of bundleEntries(graph)) {
    const source = await readFile(join(directory, bundle.output), "utf8");
    if (/\brequire\s*\(/.test(source)) {
      throw new Error(`${id} contains a CommonJS runtime dependency`);
    }
  }

  const manifestSource = await readFile(join(directory, graph.manifest.output), "utf8");
  const manifestValue: unknown = JSON.parse(manifestSource);
  const manifest = asObject(manifestValue, "Built extension manifest");
  if (manifest.version !== inputs.version) {
    throw new Error("Built extension manifest version does not match package.json");
  }
  if (manifest.minimum_chrome_version !== String(graph.minimumChromeVersion)) {
    throw new Error(
      "Built extension manifest minimum_chrome_version diverges from the build graph",
    );
  }
  if (typeof manifest.key !== "string" || manifest.key !== inputs.publicKey) {
    throw new Error("Built extension manifest key does not match connector auth public key");
  }
  const actualExtensionId = extensionPackageIdFromPublicKey(manifest.key);
  if (actualExtensionId !== expectedExtensionId) {
    throw new Error("Built extension manifest key derives an unexpected Chrome extension id");
  }
  const evidenceArtifact = graph.artifacts.evidence;
  if (evidenceArtifact?.kind !== "generated") {
    throw new Error("Extension evidence must be a generated build artifact");
  }
  const evidence = Schema.decodeUnknownSync(ChromeExtensionExpectation, {
    onExcessProperty: "error",
  })(JSON.parse(await readFile(join(directory, evidenceArtifact.output), "utf8")));
  if (
    evidence.extensionId !== expectedExtensionId ||
    evidence.displayVersion !== inputs.version ||
    evidence.protocolFingerprint !== inputs.protocolFingerprint
  ) {
    throw new Error("Built extension evidence diverges from the candidate inputs");
  }
  const serviceWorker = graph.artifacts[String(graph.manifest.serviceWorker)];
  const defaultPopup = graph.artifacts[String(graph.manifest.defaultPopup)];
  const background = asObject(manifest.background, "Built extension manifest background");
  const action = asObject(manifest.action, "Built extension manifest action");
  if (background.service_worker !== serviceWorker?.output) {
    throw new Error("Built extension manifest service_worker diverges from the build graph");
  }
  if (serviceWorker?.kind !== "bundle")
    throw new Error("Extension service worker bundle is missing");
  const serviceWorkerSource = await readFile(join(directory, serviceWorker.output), "utf8");
  if (!serviceWorkerSource.includes(inputs.protocolFingerprint)) {
    throw new Error("Built service worker does not contain the candidate protocol fingerprint");
  }
  if (action.default_popup !== defaultPopup?.output) {
    throw new Error("Built extension manifest default_popup diverges from the build graph");
  }
  for (const reference of manifestAssetReferences(manifest)) {
    if (!actualFiles.has(reference)) {
      throw new Error(`Built extension manifest references missing asset: ${reference}`);
    }
  }

  for (const reference of Object.values(graph.htmlReferences)) {
    const document = graph.artifacts[reference.document];
    if (!document) throw new Error(`HTML document artifact is missing: ${reference.document}`);
    const html = await readFile(join(directory, document.output), "utf8");
    const actual = localHtmlReferences(html);
    const expected = new Set(
      reference.artifacts.map((artifact) => {
        const target = graph.artifacts[artifact];
        if (!target) throw new Error(`HTML target artifact is missing: ${artifact}`);
        return posix.relative(posix.dirname(document.output), target.output);
      }),
    );
    const missingReferences = setDifference(expected, actual);
    const extraReferences = setDifference(actual, expected);
    if (missingReferences.length || extraReferences.length) {
      throw new Error(
        `HTML asset graph mismatch for ${document.output}; missing=[${missingReferences.join(", ")}], extra=[${extraReferences.join(", ")}]`,
      );
    }
    for (const target of actual) {
      const referencedOutput = posix.normalize(posix.join(posix.dirname(document.output), target));
      if (!actualFiles.has(referencedOutput)) {
        throw new Error(`${document.output} references missing asset: ${target}`);
      }
    }
  }
};
