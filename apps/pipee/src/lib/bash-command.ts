export interface ParsedBashCommand {
  command: string
  excludeFromContext: boolean
}

export const MAX_LIVE_BASH_OUTPUT_CHARS = 200_000

export function appendLiveBashOutput(output: string, chunk: string): string {
  const next = output + chunk
  if (next.length <= MAX_LIVE_BASH_OUTPUT_CHARS) return next
  return `[live output limited to the last ${MAX_LIVE_BASH_OUTPUT_CHARS.toLocaleString()} characters]\n${next.slice(-MAX_LIVE_BASH_OUTPUT_CHARS)}`
}

export function parseBashCommand(input: string): ParsedBashCommand | null {
  if (!input.startsWith("!")) return null

  const excludeFromContext = input.startsWith("!!")
  const command = input.slice(excludeFromContext ? 2 : 1).trim()
  return command ? { command, excludeFromContext } : null
}
