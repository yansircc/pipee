import { Clock, Effect, Schedule, type Duration } from "effect"

export const after = (delay: Duration.Input, action: () => void) =>
  Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(action)))

export const observeCurrentTime = (interval: Duration.Input, onTime: (epochMillis: number) => void) =>
  Clock.currentTimeMillis.pipe(
    Effect.tap((epochMillis) => Effect.sync(() => onTime(epochMillis))),
    Effect.repeat(Schedule.spaced(interval)),
    Effect.asVoid,
  )
