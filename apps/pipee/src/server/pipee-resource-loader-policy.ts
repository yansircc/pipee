import type { CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent"

export type PipeeResourceLoaderPolicy = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>

/**
 * Pipee is a closed skill consumer. Ambient agent projections never become
 * runtime capabilities; callers must name every authorized skill path.
 */
export const pipeeResourceLoaderPolicy = (
  additionalSkillPaths: ReadonlyArray<string> = [],
): PipeeResourceLoaderPolicy => ({
  noSkills: true,
  additionalSkillPaths: [...additionalSkillPaths],
})
