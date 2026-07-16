import type { DomainRequest } from "./codec.js";
import { COMMAND_DEADLINES_MS } from "./bridge-contract.js";
import {
  operationDeadlineProjectionFor,
  type OperationDeadlineKind,
} from "./operation-contract.js";
import type { WireCommand } from "./schema.js";

type TimedCommand = DomainRequest | WireCommand;

export type CommandDeadlinePolicy = typeof COMMAND_DEADLINES_MS;

export const RESULT_DELIVERY_GRACE_MS = COMMAND_DEADLINES_MS.resultDeliveryGrace;

type DeadlineOperation = {
  readonly default: unknown;
  readonly navigate: { readonly timeoutMs?: number; readonly snapshot?: unknown };
  readonly wait: { readonly timeoutMs?: number; readonly intervalMs?: number };
  readonly screenshot: { readonly capture: { readonly kind: "viewport" | "full-page-tiles" } };
  readonly "text-input": { readonly text: string };
};

const deadlineEvaluators = {
  default: (_operation, policy) => policy.defaultExecution,
  navigate: (operation, policy) =>
    (operation.timeoutMs ?? policy.navigateDefault) +
    policy.navigateOverhead +
    (operation.snapshot === undefined ? 0 : policy.defaultExecution),
  wait: (operation, policy) =>
    (operation.timeoutMs ?? policy.waitDefault) +
    (operation.intervalMs ?? policy.waitIntervalDefault) +
    policy.waitOverhead,
  screenshot: (operation, policy) =>
    operation.capture.kind === "full-page-tiles"
      ? policy.fullPageScreenshot
      : policy.defaultExecution,
  "text-input": (operation, policy) =>
    Math.min(
      policy.textInputMaximum,
      policy.textInputBase + Array.from(operation.text).length * policy.textInputPerCharacter,
    ),
} satisfies {
  readonly [Kind in OperationDeadlineKind]: (
    operation: DeadlineOperation[Kind],
    policy: CommandDeadlinePolicy,
  ) => number;
};

export const browserExecutionTimeoutMs = (
  command: TimedCommand,
  policy: CommandDeadlinePolicy = COMMAND_DEADLINES_MS,
): number => {
  const projection = operationDeadlineProjectionFor(command);
  const evaluate = deadlineEvaluators[projection.kind] as (
    operation: unknown,
    policy: CommandDeadlinePolicy,
  ) => number;
  return evaluate(projection.operation, policy);
};

export const bridgeDeliveryTimeoutMs = (
  command: TimedCommand,
  policy: CommandDeadlinePolicy = COMMAND_DEADLINES_MS,
): number => browserExecutionTimeoutMs(command, policy) + policy.resultDeliveryGrace;
