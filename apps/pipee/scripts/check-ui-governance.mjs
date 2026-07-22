import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../src/", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
const viteConfigPath = fileURLToPath(new URL("../vite.config.ts", import.meta.url))
const appStylesPath = fileURLToPath(new URL("../src/styles/app.css", import.meta.url))
const preflightPath = fileURLToPath(new URL("../src/styles/preflight.css", import.meta.url))
const interactionRoot = "ui/interaction/"
const interactionVendor =
  /^(?:react-aria-components|react-aria|react-stately)(?:\/|$)|^@react-(?:aria|stately|types)\/|^@internationalized\/|^@tanstack\/(?:react-)?hotkeys(?:\/|$)/

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    }),
  )
  return nested.flat()
}

const sourceFiles = (await walk(root)).filter((path) => [".ts", ".tsx"].includes(extname(path)))
const sources = new Map(
  await Promise.all(sourceFiles.map(async (path) => [relative(root, path), await readFile(path, "utf8")])),
)
const failures = []

const productionSources = [...sources].filter(([path]) => !path.includes(".test.") && !path.startsWith("tests/"))
const forbiddenDomainSpecifiers = new Set([
  "@pipee/companion-contracts/chrome",
  "@pipee/companion-contracts/loop",
  "@pipee/companion-contracts/weixin",
])
const forbiddenExtensionIdentities = [
  "@yansircc/pi-chrome",
  "@yansircc/pi-loop",
  "@yansircc/pi-weixin",
  "pi-chrome/status",
  "pi-loop/status",
  "pi-weixin/status",
  "PI_COMPANION_PACKAGE_NAMES",
  "ChromeStatusProjection",
  "LoopStatusProjection",
  "WeixinStatusProjection",
]

for (const [path, source] of productionSources) {
  const moduleSpecifiers = [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map(
    ([, specifier]) => specifier,
  )
  for (const specifier of moduleSpecifiers) {
    if (forbiddenDomainSpecifiers.has(specifier))
      failures.push(`${path}: Pipee production source imports extension domain ${specifier}`)
  }
  for (const identity of forbiddenExtensionIdentities) {
    if (source.includes(identity))
      failures.push(`${path}: Pipee production source knows extension identity ${identity}`)
  }
}

const protocolPackagePath = join(repositoryRoot, "protocols/companion-contracts/package.json")
const protocolPackage = JSON.parse(await readFile(protocolPackagePath, "utf8"))
for (const domain of ["chrome", "loop", "weixin"]) {
  if (protocolPackage.exports?.[`./${domain}`] !== undefined)
    failures.push(`protocols/companion-contracts: shared protocol exports extension domain ${domain}`)
}

/** @type {ReadonlyArray<readonly [string, ReadonlySet<string>]>} */
const extensionPresentationImports = [
  ["extensions/chrome/src", new Set(["pi/extension.ts", "pi/presentation.ts"])],
  ["extensions/loop/src", new Set(["pi/extension.ts", "pi/presentation.ts"])],
  ["extensions/weixin/src", new Set(["presentation.ts"])],
  ["extensions/weixin/extensions", new Set(["weixin.ts"])],
]
for (const [relativeDirectory, allowed] of extensionPresentationImports) {
  const directory = join(repositoryRoot, relativeDirectory)
  for (const path of await walk(directory)) {
    if (![".ts", ".tsx"].includes(extname(path)) || path.includes(".test.")) continue
    const source = await readFile(path, "utf8")
    if (
      !source.includes("@pipee/companion-contracts/presentation") &&
      !source.includes("@pipee/extension-kit") &&
      !source.includes("LivePresentationPort")
    )
      continue
    const localPath = relative(directory, path)
    if (!allowed.has(localPath))
      failures.push(`${relativeDirectory}/${localPath}: presentation protocol escaped its admitted adapter boundary`)
  }
}

const [viteConfig, appStyles, preflight] = await Promise.all([
  readFile(viteConfigPath, "utf8"),
  readFile(appStylesPath, "utf8"),
  readFile(preflightPath, "utf8"),
])

if (!viteConfig.includes('styleResolution: "legacy-expand-shorthands"')) {
  failures.push("vite.config.ts: StyleX must preserve the existing shorthand visual contract")
}
if (!appStyles.startsWith('@import "./preflight.css";')) {
  failures.push("styles/app.css: Pipee preflight must load before product styles")
}
for (const contract of ["border: 0 solid", "font: inherit", "background-color: transparent"]) {
  if (!preflight.includes(contract)) failures.push(`styles/preflight.css: missing browser normalization ${contract}`)
}

for (const [path, source] of sources) {
  const moduleSpecifiers = [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map(
    ([, specifier]) => specifier,
  )
  if (!path.startsWith(interactionRoot) && moduleSpecifiers.some((specifier) => interactionVendor.test(specifier))) {
    failures.push(`${path}: interaction vendor import is outside ${interactionRoot}`)
  }
  if (
    !path.startsWith("browser/") &&
    !path.startsWith(interactionRoot) &&
    /(?:document|window|globalThis|visualViewport)\??\.addEventListener\(/.test(source)
  ) {
    failures.push(`${path}: global browser listener registration bypasses BrowserPlatform or the interaction owner`)
  }
  if (
    /<[A-Za-z][^>]*className\s*=[^>]*\{\.\.\.stylex\.props\(/s.test(source) ||
    /<[A-Za-z][^>]*\{\.\.\.stylex\.props\([^>]*className\s*=/s.test(source)
  ) {
    failures.push(`${path}: JSX prop ordering drops either the semantic class or the StyleX class`)
  }
  if (source.includes("<form") && !source.includes('from "@/ui/interaction/AppForm"')) {
    failures.push(`${path}: native form bypasses the TanStack AppForm owner`)
  }
  if (source.includes("new FormData(")) {
    failures.push(`${path}: FormData creates a second submission state owner`)
  }
}

const governedLayers = [
  ["ui/interaction/SettingsWorkspace.tsx", "--layer-modal"],
  ["ui/interaction/Tooltip.tsx", "--layer-tooltip"],
]
for (const [path, token] of governedLayers) {
  const source = sources.get(path)
  if (source === undefined || !source.includes(`var(${token})`)) {
    failures.push(`${path}: shared surface must use ${token}`)
  }
  if (source !== undefined && /zIndex:\s*\d/.test(source)) {
    failures.push(`${path}: shared surface contains an unnamed numeric layer`)
  }
}
if (!sources.get("ui/interaction/Hotkeys.ts")?.includes("@tanstack/react-hotkeys")) {
  failures.push("ui/interaction/Hotkeys.ts: TanStack Hotkeys must own application shortcuts")
}
if (!sources.get("ui/interaction/AppForm.tsx")?.includes("@tanstack/react-form")) {
  failures.push("ui/interaction/AppForm.tsx: TanStack Form must own application submissions")
}
for (const [path, source] of sources) {
  if (path !== "ui/interaction/AppForm.tsx" && source.includes("@tanstack/react-form")) {
    failures.push(`${path}: TanStack Form import bypasses ui/interaction/AppForm.tsx`)
  }
}
if (/onDocumentKeyDown/.test(sources.get("browser/browser-platform.ts") ?? "")) {
  failures.push("browser/browser-platform.ts: application shortcuts must not have a second listener owner")
}
if (!sources.get("browser/viewport.ts")?.includes('"(max-width: 760px)"')) {
  failures.push("browser/viewport.ts: runtime mobile state must share the 760px visual breakpoint")
}
if (!appStyles.includes("@media (max-width: 760px)") || !appStyles.includes("@media (min-width: 761px)")) {
  failures.push("styles/app.css: visual mobile state must preserve the 760/761px breakpoint pair")
}

const governedOwners = [
  ["components/ModelsConfig.tsx", /import \{ SettingsWorkspace \}/, /<SettingsWorkspace\b/],
  ["components/PluginsConfig.tsx", /import \{ SettingsWorkspace \}/, /<SettingsWorkspace\b/],
  ["components/SkillsConfig.tsx", /import \{ SettingsWorkspace \}/, /<SettingsWorkspace\b/],
  ["components/PluginsConfig.tsx", /import \{ SettingsToggle as Toggle \}/, /<Toggle\b/],
  ["components/SkillsConfig.tsx", /import \{ SettingsToggle as Toggle \}/, /<Toggle\b/],
]
for (const [path, ownerImport, use] of governedOwners) {
  const source = sources.get(path) ?? ""
  if (!ownerImport.test(source) || !use.test(source)) {
    failures.push(`${path}: inventory-classified shared semantic bypasses its admitted owner`)
  }
}
if (!/type SettingsSurface\s*=/.test(sources.get("components/AppShell.tsx") ?? "")) {
  failures.push("components/AppShell.tsx: settings surfaces must share one discriminated state owner")
}

const legitimateNativeBoundaries = [
  ["components/MarkdownBody.tsx", /<button\b/],
  ["components/ModelsConfig.tsx", /type="file"/],
  ["components/ChatInput.tsx", /<textarea\b/],
  ["components/FileViewer.tsx", /<button\b/],
  ["components/ChatWindow.tsx", /role="dialog"/],
]
for (const [path, pattern] of legitimateNativeBoundaries) {
  if (!pattern.test(sources.get(path) ?? "")) {
    failures.push(`${path}: named native/domain boundary disappeared; reclassify the gate before migration`)
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log("UI governance boundary verified")
}
