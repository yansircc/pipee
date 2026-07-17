const BUMPS = new Set(["major", "minor", "patch"]);

export const bumpVersion = (version, bump) => {
  const match = String(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error(`release version must be strict SemVer: ${version}`);
  if (!BUMPS.has(bump)) throw new Error(`unknown release bump: ${bump}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    bump === "major"
      ? [major + 1, 0, 0]
      : bump === "minor"
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1]
  ).join(".");
};
