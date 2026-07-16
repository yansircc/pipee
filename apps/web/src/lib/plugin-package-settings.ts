const RESOURCE_FILTERS = ["extensions", "skills", "prompts", "themes"] as const

export const PI_COMPANION_PACKAGE_NAMES = {
  chrome: "@yansircc/pi-chrome",
  loop: "@yansircc/pi-loop",
  weixin: "@yansircc/pi-weixin",
} as const

export type PiCompanionPackage = keyof typeof PI_COMPANION_PACKAGE_NAMES

export function isPiCompanionPackage(packageName: string | undefined, companion: PiCompanionPackage): boolean {
  return packageName === PI_COMPANION_PACKAGE_NAMES[companion]
}

export type ConfiguredPackageSource =
  | string
  | {
      source: string
      autoload?: boolean
      extensions?: string[]
      skills?: string[]
      prompts?: string[]
      themes?: string[]
    }

export function getPackageSource(entry: ConfiguredPackageSource): string {
  return typeof entry === "string" ? entry : entry.source
}

export function isLocalPackageSource(source: string): boolean {
  const value = source.trim()
  return !["npm:", "git:", "github:", "http:", "https:", "ssh:"].some((prefix) => value.startsWith(prefix))
}

export function isDisabledPackage(entry: ConfiguredPackageSource): boolean {
  if (typeof entry === "string") return false
  return RESOURCE_FILTERS.every((key) => Array.isArray(entry[key]) && entry[key].length === 0)
}

export function removeConfiguredPackage(
  packages: ReadonlyArray<ConfiguredPackageSource>,
  source: string,
): { changed: boolean; packages: ConfiguredPackageSource[] } {
  const next = packages.filter((entry) => getPackageSource(entry) !== source)
  return { changed: next.length !== packages.length, packages: next }
}

function enablePackage(entry: Exclude<ConfiguredPackageSource, string>): ConfiguredPackageSource {
  const enabled = { ...entry }
  for (const key of RESOURCE_FILTERS) delete enabled[key]
  return Object.keys(enabled).length === 1 ? enabled.source : enabled
}

export function setConfiguredPackageDisabled(
  packages: ReadonlyArray<ConfiguredPackageSource>,
  source: string,
  disabled: boolean,
): { changed: boolean; packages: ConfiguredPackageSource[] } {
  let changed = false
  const next = packages.map((entry): ConfiguredPackageSource => {
    if (getPackageSource(entry) !== source) return entry
    changed = true
    if (!disabled) return typeof entry === "string" ? entry : enablePackage(entry)
    return {
      ...(typeof entry === "string" ? { source: entry } : entry),
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }
  })
  return { changed, packages: next }
}
