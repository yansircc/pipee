import type { LoopControlRequest as LoopControlRequestValue } from "@pi-suite/companion-contracts/loop"

export {
  LoopControlRequest,
  LoopPhaseProjection,
  LoopProjection,
  LoopScheduleProjection,
  LoopStatusProjection,
} from "@pi-suite/companion-contracts/loop"

export type LoopControlAction = LoopControlRequestValue["action"]

export const controlRequest = (action: LoopControlAction): LoopControlRequestValue => ({
  kind: "pi-loop/control",
  version: 1,
  action,
})
