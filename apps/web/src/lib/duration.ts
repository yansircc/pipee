const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const decimal = (value: number): string => value.toFixed(1).replace(/\.0$/, "")

const join = (major: string, minorValue: number, minorUnit: string): string =>
  minorValue > 0 ? `${major} ${minorValue}${minorUnit}` : major

export function formatDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.round(durationMs))
  if (milliseconds < SECOND) return `${milliseconds}ms`
  if (milliseconds < MINUTE) return `${decimal(milliseconds / SECOND)}s`
  if (milliseconds < HOUR) {
    return join(`${Math.floor(milliseconds / MINUTE)}min`, Math.floor((milliseconds % MINUTE) / SECOND), "s")
  }
  if (milliseconds < DAY) {
    return join(`${Math.floor(milliseconds / HOUR)}h`, Math.floor((milliseconds % HOUR) / MINUTE), "min")
  }
  return join(`${Math.floor(milliseconds / DAY)}day`, Math.floor((milliseconds % DAY) / HOUR), "h")
}

export function elapsedDuration(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || end < start) return null
  return end - start
}
