export const requiredPiRuntimePackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

const lockfileCoordinate = /^  '(@earendil-works\/pi-[^@']+)@([^(']+)(?:\([^']*\))?':$/gm;

export const verifyPiReleaseTrain = (lockfile) => {
  const versionsByPackage = new Map();
  for (const match of lockfile.matchAll(lockfileCoordinate)) {
    const [, name, version] = match;
    const versions = versionsByPackage.get(name) ?? new Set();
    versions.add(version);
    versionsByPackage.set(name, versions);
  }

  const missing = requiredPiRuntimePackages.filter((name) => !versionsByPackage.has(name));
  if (missing.length > 0) {
    throw new Error(`Pi release train is missing runtime packages: ${missing.join(", ")}`);
  }

  const versions = new Set(
    [...versionsByPackage.values()].flatMap((packageVersions) => [...packageVersions]),
  );
  if (versions.size !== 1) {
    const resolved = [...versionsByPackage]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, packageVersions]) => `${name}=${[...packageVersions].sort().join("|")}`)
      .join(", ");
    throw new Error(`Pi release train must resolve to one version; found ${resolved}`);
  }

  return versions.values().next().value;
};
