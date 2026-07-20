import * as Schedule from "effect/Schedule";

// Both policies share one capped exponential shape. Local durability has one writer and no shared
// downstream, while bridge delivery/polling can converge across Chrome profile workers and must
// perturb that shape to avoid synchronized loopback pressure.
const cappedExponentialRetrySchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("2 seconds"),
]);

export const localDurabilityRetrySchedule = cappedExponentialRetrySchedule;
export const sharedBridgeRetrySchedule = cappedExponentialRetrySchedule.pipe(Schedule.jittered);
