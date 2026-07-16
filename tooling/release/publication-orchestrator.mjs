import { publicationDecision, requireRegistryIntegrity } from "./registry-state.mjs";

export const publishCandidateSet = ({ artifacts, lookup, publish }) => {
  const plan = artifacts.map((artifact) => ({
    artifact,
    decision: publicationDecision(lookup(artifact), artifact.integrity),
  }));

  for (const { artifact, decision } of plan) {
    if (decision._tag === "Publish") publish(artifact);
  }

  for (const { artifact } of plan) {
    requireRegistryIntegrity(lookup(artifact), artifact.integrity);
  }

  return plan.map(({ artifact, decision }) => ({ name: artifact.name, decision: decision._tag }));
};
