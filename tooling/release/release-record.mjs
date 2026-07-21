import { bumpVersion } from "./version.mjs";

const strictVersion = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const subjectPattern = /^chore\(release\): release-([0-9a-f]{12})$/;

const uniqueTrailer = (lines, name, pattern) => {
  const values = lines.flatMap((line) => {
    const match = line.match(pattern);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (values.length !== 1) throw new Error(`release record requires exactly one ${name} trailer`);
  return values[0];
};

export const parseReleaseRecord = (message) => {
  const lines = String(message).split(/\r?\n/);
  const subject = lines[0] ?? "";
  const hasReleaseMarker =
    subject.startsWith("chore(release):") || lines.some((line) => /^Release-Source:/.test(line));
  if (!hasReleaseMarker) return undefined;

  const subjectMatch = subject.match(subjectPattern);
  if (subjectMatch?.[1] === undefined)
    throw new Error("release record has a non-canonical subject");
  const source = uniqueTrailer(lines, "Release-Source", /^Release-Source:\s*([0-9a-f]{40})\s*$/);
  const base = uniqueTrailer(lines, "Release-Base", /^Release-Base:\s*([0-9a-f]{40})\s*$/);
  if (source.slice(0, 12) !== subjectMatch[1]) {
    throw new Error("release record tag does not match its source");
  }
  const packages = lines.flatMap((line) => {
    const match = line.match(
      new RegExp(
        `^Release-Package:\\s*([a-z][a-z0-9-]*)\\s+(${strictVersion})\\s+(major|minor|patch)\\s*$`,
      ),
    );
    return match === null ? [] : [{ id: match[1], version: match[2], bump: match[3] }];
  });
  if (packages.length === 0)
    throw new Error("release record requires at least one Release-Package");
  if (new Set(packages.map(({ id }) => id)).size !== packages.length) {
    throw new Error("release record repeats a package");
  }
  if (base === source) throw new Error("release source must advance its base");
  return { source, base, tag: `release-${subjectMatch[1]}`, packages };
};

export const assertReleaseRecordCommit = ({
  record,
  parents,
  manifestVersions,
  sourceManifestVersions,
  packageIds,
  packageManifestPaths,
  changedFiles,
}) => {
  if (parents.length !== 1 || parents[0] !== record.source) {
    throw new Error("release commit parent must be its development source");
  }
  const known = new Set(packageIds);
  for (const entry of record.packages) {
    if (!known.has(entry.id)) throw new Error(`release record names unknown package ${entry.id}`);
    if (manifestVersions[entry.id] !== entry.version) {
      throw new Error(`release record version does not match ${entry.id} manifest`);
    }
    if (bumpVersion(sourceManifestVersions[entry.id], entry.bump) !== entry.version) {
      throw new Error(`release record version does not match ${entry.id} requested bump`);
    }
  }
  if (changedFiles !== undefined) {
    const expectedManifests = record.packages.map(({ id }) => packageManifestPaths[id]).sort();
    const manifestPaths = new Set(Object.values(packageManifestPaths));
    const changedManifests = changedFiles
      .filter(({ path }) => manifestPaths.has(path))
      .map(({ path }) => path)
      .sort();
    if (JSON.stringify(changedManifests) !== JSON.stringify(expectedManifests)) {
      throw new Error("release commit changed the wrong package manifests");
    }
    const changeFiles = changedFiles.filter(({ path }) => !manifestPaths.has(path));
    if (
      changeFiles.length === 0 ||
      changeFiles.some(
        ({ status, path }) =>
          status !== "D" || !/^release\/changes\/[a-z0-9][a-z0-9-]*\.json$/.test(path),
      )
    ) {
      throw new Error("release commit must only delete its tracked changesets");
    }
  }
  return record;
};
