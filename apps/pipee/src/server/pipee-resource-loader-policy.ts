import type { CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent"
import type { Path } from "effect"

export type PipeeResourceLoaderPolicy = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>

/**
 * Pipee is a closed skill consumer. Only Pi-native skill roots become runtime
 * capabilities; ambient agent projections never do.
 */
export const pipeeResourceLoaderPolicy = (
  path: Path.Path,
  cwd: string,
  agentDir: string,
): PipeeResourceLoaderPolicy => ({
  noSkills: true,
  additionalSkillPaths: [path.join(agentDir, "skills"), path.join(cwd, ".pi", "skills")],
})
