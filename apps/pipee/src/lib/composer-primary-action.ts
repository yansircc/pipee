export type StreamingPrimaryAction = "stop" | "followup" | "steer"

export function resolveStreamingPrimaryAction(options: {
  readonly hasDraft: boolean
  readonly canFollowUp: boolean
  readonly canSteer: boolean
}): StreamingPrimaryAction {
  if (!options.hasDraft) return "stop"
  if (options.canFollowUp) return "followup"
  if (options.canSteer) return "steer"
  return "stop"
}
