import { requireRegistryIntegrity } from "./registry-state.mjs";

export const waitForRegistrySet = async ({ artifacts, lookup, wait, maxAttempts = 30 }) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observations = artifacts.map((artifact) => ({
      artifact,
      lookup: lookup(artifact),
    }));

    for (const { artifact, lookup: observation } of observations) {
      if (observation._tag === "Present") {
        requireRegistryIntegrity(observation, artifact.integrity);
      }
    }

    const missing = observations.filter(
      ({ lookup: observation }) => observation._tag === "Missing",
    );
    if (missing.length === 0) return;
    if (attempt === maxAttempts) {
      throw new Error(
        `registry versions are not publicly visible: ${missing
          .map(({ artifact }) => `${artifact.name}@${artifact.version}`)
          .join(", ")}`,
      );
    }
    await wait();
  }
};
