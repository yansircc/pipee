import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import { Type, type Static } from "@sinclair/typebox";
import { Clock, Data, Effect, Exit, ManagedRuntime, Schema, Scope } from "effect";
import {
  makeRuntimeRetentionSlot,
  structuredView,
  withCompanionView,
  withConversationView,
  webSurface,
  type RuntimeRetentionSlot,
  type WebSurfaceSlot,
} from "@pipee/extension-kit";
import type { StructuredViewPort } from "@pipee/companion-contracts/host-capabilities";
import packageJson from "../../package.json" with { type: "json" };
import { loadLoopConfig } from "../application/config.js";
import { makeLoopOperations, type LoopOperations } from "../application/operations.js";
import { makeLoopRepository, type LoopRepository } from "../application/repository.js";
import { makeScheduler, PromptDeliveryFailure, type Scheduler } from "../application/scheduler.js";
import { cronToHuman } from "../domain/cron.js";
import type { Loop, LoopConfig, Occurrence } from "../domain/model.js";
import { projectLoops } from "./status.js";
import { makeSessionLoopPersistence } from "./session-state.js";
import { projectLoopConversationView } from "./conversation-view.js";
import { projectLoopCompanionView } from "./companion-view.js";
import { LoopWebAction, projectLoopWebView } from "./web-surface.js";

const runtime = ManagedRuntime.make(nodeServicesLayer);

type Session = {
  readonly context: ExtensionContext;
  readonly config: LoopConfig;
  readonly repository: LoopRepository;
  readonly operations: LoopOperations;
  readonly scheduler: Scheduler;
  readonly scope: Scope.Closeable;
  readonly statusView: StructuredViewPort | undefined;
  readonly retention: RuntimeRetentionSlot;
  readonly surface: WebSurfaceSlot;
};

export class SessionUnavailable extends Data.TaggedError("SessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, Session>();

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>): Promise<A> =>
  runtime.runPromise(effect);

const runDetached = <A, E>(effect: Effect.Effect<A, E, NodeServices>): void => {
  runtime.runFork(effect);
};

const withSession = <A, E>(
  pi: ExtensionAPI,
  use: (active: Session) => Effect.Effect<A, E, NodeServices>,
): Effect.Effect<A, E | SessionUnavailable, NodeServices> =>
  Effect.gen(function* () {
    const active = sessions.get(pi as object);
    if (!active) {
      return yield* new SessionUnavailable({ message: "pi-loop session has not started" });
    }
    return yield* use(active);
  });

const describeLoop = (loop: Loop): string => {
  const phase =
    loop.phase._tag === "Waiting"
      ? `due ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(loop.phase.dueAt)}`
      : "awaiting model arm";
  const cadence =
    loop._tag === "Cron"
      ? cronToHuman(loop.spec.expression)
      : loop._tag === "Interval"
        ? `every ${loop.spec.periodMs}ms`
        : loop._tag.toLowerCase();
  return `[${loop.id}] ${cadence} — ${loop.prompt.slice(0, 60)} (${phase}, ${loop.retention})`;
};

const toolResult = (
  text: string,
  view?: ReturnType<typeof projectLoopConversationView>,
): AgentToolResult<unknown> => ({
  content: [{ type: "text" as const, text }],
  details: view === undefined ? undefined : withConversationView({}, view),
});

const notifyFailure = (context: ExtensionContext, error: unknown) =>
  Effect.sync(() => {
    if (context.hasUI) {
      const message = error instanceof Error ? error.message : String(error);
      context.ui.notify(`pi-loop: ${message}`, "error");
    }
  });

const refreshStatus = (active: Session) =>
  active.repository.list.pipe(
    Effect.flatMap((loops) =>
      Clock.currentTimeMillis.pipe(Effect.map((observedAt) => ({ loops, observedAt }))),
    ),
    Effect.flatMap(({ loops, observedAt }) =>
      Effect.gen(function* () {
        if (!active.context.hasUI) return;
        active.context.ui.setStatus(
          "pi-loop",
          loops.length === 0 ? undefined : `${loops.length} loop${loops.length === 1 ? "" : "s"}`,
        );
        const status = {
          kind: "pi-loop/status" as const,
          version: 1 as const,
          sessionId: active.context.sessionManager.getSessionId(),
          observedAt,
          loops: projectLoops(loops),
        };
        active.statusView?.replace(
          "status",
          withCompanionView(status, projectLoopCompanionView(status)),
        );
        active.surface.replace(
          projectLoopWebView(loops, active.context.sessionManager.getSessionId(), observedAt),
        );
        yield* Effect.sync(() =>
          active.retention.replace(loops[0] ? { reason: "automation-present" } : undefined),
        );
      }),
    ),
  );

const stopSession = (pi: ExtensionAPI, active: Session) =>
  Scope.close(active.scope, Exit.succeed(undefined)).pipe(
    Effect.ensuring(Effect.sync(() => sessions.delete(pi as object))),
  );

const startSession = (pi: ExtensionAPI, context: ExtensionContext) =>
  Effect.gen(function* () {
    const previous = sessions.get(pi as object);
    if (previous) yield* stopSession(pi, previous);
    const scope = yield* Scope.make("sequential");
    yield* Effect.gen(function* () {
      const config = yield* loadLoopConfig(context.cwd);
      const sessionPersistence = yield* makeSessionLoopPersistence(pi, context);
      const repository = yield* makeLoopRepository(context.cwd, config, sessionPersistence);
      const operations = makeLoopOperations(repository, config);
      const deliver = (item: Occurrence) =>
        Effect.try({
          try: () => {
            if (context.hasUI) context.ui.notify(`Loop firing: ${item.loopId}`, "info");
            pi.sendUserMessage(item.prompt);
          },
          catch: (cause) => new PromptDeliveryFailure({ occurrenceId: item.id, cause }),
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              const current = sessions.get(pi as object);
              return current ? refreshStatus(current) : Effect.void;
            }),
          ),
        );
      const scheduler = yield* makeScheduler(repository, deliver, config);
      const retention = yield* makeRuntimeRetentionSlot(context.ui, packageJson.name, "automation");
      yield* scheduler.run.pipe(
        Effect.catch((error) =>
          Effect.logError("pi-loop scheduler stopped", { cause: error }).pipe(
            Effect.andThen(Effect.never),
          ),
        ),
        Effect.forkIn(scope),
      );
      let active!: Session;
      const surface = yield* webSurface(context.ui, packageJson.name, (request, signal) =>
        runtime.runPromise(
          Schema.decodeUnknownEffect(LoopWebAction)(request.payload).pipe(
            Effect.flatMap((action): Effect.Effect<void, unknown> => {
              switch (action._tag) {
                case "RunNow":
                  return active.scheduler.runNow(action.id);
                case "SetEnabled":
                  return active.operations
                    .setEnabled(action.id, action.enabled)
                    .pipe(Effect.asVoid);
                case "Delete":
                  return active.operations.remove(action.id).pipe(Effect.asVoid);
                case "Update":
                  return active.operations
                    .update({
                      id: action.id,
                      prompt: action.prompt,
                      label: action.label,
                      schedule: action.schedule,
                    })
                    .pipe(Effect.asVoid);
              }
            }),
            Effect.tap(() => active.scheduler.drain),
            Effect.tap(() => refreshStatus(active)),
            Effect.match({
              onFailure: (error) => ({ _tag: "Failed" as const, message: String(error) }),
              onSuccess: () => ({ _tag: "Accepted" as const, payload: null }),
            }),
          ),
          { signal },
        ),
      );
      active = {
        context,
        config,
        repository,
        operations,
        scheduler,
        scope,
        statusView: structuredView(context.ui, packageJson.name),
        retention,
        surface,
      };
      yield* Effect.sync(() => sessions.set(pi as object, active));
      yield* refreshStatus(active);
      if (context.hasUI && (yield* repository.projectAccess) === "follower") {
        context.ui.notify(
          "Another Pi session currently owns project-retained loops; this session will take over if that owner exits.",
          "warning",
        );
      }
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
  });

const registrations = new WeakSet<object>();

const ScheduleParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("interval"),
    periodSeconds: Type.Number({ minimum: 1 }),
    runImmediately: Type.Optional(Type.Boolean({ default: true })),
  }),
  Type.Object({
    kind: Type.Literal("cron"),
    expression: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("once"),
    delaySeconds: Type.Number({ minimum: 1 }),
  }),
  Type.Object({ kind: Type.Literal("dynamic") }),
]);
const DeleteTargetParameters = Type.Union([
  Type.Object({ kind: Type.Literal("one"), id: Type.String() }),
  Type.Object({ kind: Type.Literal("all") }),
]);

type ScheduleParameter = Static<typeof ScheduleParameters>;

const scheduleInput = (schedule: ScheduleParameter) =>
  schedule.kind === "interval"
    ? { ...schedule, runImmediately: schedule.runImmediately ?? true }
    : schedule;

export default function piLoop(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  pi.registerTool({
    name: "loop_create",
    label: "Create Loop",
    description: "Create an interval, cron, one-shot, or agent-scheduled loop.",
    parameters: Type.Object({
      prompt: Type.String(),
      schedule: ScheduleParameters,
      retention: Type.Optional(
        Type.Union([Type.Literal("session"), Type.Literal("project")], {
          default: "session",
        }),
      ),
      label: Type.Optional(Type.String()),
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.operations
            .create({
              prompt: parameters.prompt ?? "",
              retention: parameters.retention ?? "session",
              schedule: scheduleInput(parameters.schedule as ScheduleParameter),
              ...(parameters.label === undefined ? {} : { label: parameters.label }),
            })
            .pipe(
              Effect.tap(() => active.scheduler.drain),
              Effect.tap(() => refreshStatus(active)),
              Effect.map((loop) =>
                toolResult(
                  `Created ${describeLoop(loop)}`,
                  projectLoopConversationView(loop, "Loop created"),
                ),
              ),
            ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "loop_update",
    label: "Update Loop",
    description: "Update a loop's prompt, label, or complete schedule.",
    parameters: Type.Object({
      id: Type.String(),
      prompt: Type.Optional(Type.String()),
      label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      schedule: Type.Optional(ScheduleParameters),
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.operations
            .update({
              id: parameters.id ?? "",
              ...(parameters.prompt === undefined ? {} : { prompt: parameters.prompt }),
              ...(parameters.label === undefined ? {} : { label: parameters.label }),
              ...(parameters.schedule === undefined
                ? {}
                : { schedule: scheduleInput(parameters.schedule as ScheduleParameter) }),
            })
            .pipe(
              Effect.tap(() => active.scheduler.drain),
              Effect.tap(() => refreshStatus(active)),
              Effect.map((loop) =>
                toolResult(
                  `Updated ${describeLoop(loop)}`,
                  projectLoopConversationView(loop, "Loop updated"),
                ),
              ),
            ),
        ),
      );
    },
  });

  const registerEnabledTool = (name: "loop_pause" | "loop_resume", enabled: boolean) =>
    pi.registerTool({
      name,
      label: enabled ? "Resume Loop" : "Pause Loop",
      description: `${enabled ? "Resume" : "Pause"} a loop by id.`,
      parameters: Type.Object({ id: Type.String() }),
      execute(_id, parameters) {
        return run(
          withSession(pi, (active) =>
            active.operations.setEnabled(parameters.id ?? "", enabled).pipe(
              Effect.tap(() => refreshStatus(active)),
              Effect.map((loop) =>
                toolResult(
                  `${enabled ? "Resumed" : "Paused"} ${describeLoop(loop)}`,
                  projectLoopConversationView(loop, enabled ? "Loop resumed" : "Loop paused"),
                ),
              ),
            ),
          ),
        );
      },
    });

  registerEnabledTool("loop_pause", false);
  registerEnabledTool("loop_resume", true);

  pi.registerTool({
    name: "loop_run_now",
    label: "Run Loop Now",
    description: "Run one enabled loop immediately.",
    parameters: Type.Object({ id: Type.String() }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.scheduler.runNow(parameters.id ?? "").pipe(
            Effect.tap(() => refreshStatus(active)),
            Effect.map(() => toolResult(`Ran loop ${parameters.id}`)),
          ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "loop_delete",
    label: "Delete Loop",
    description: "Delete one loop or every loop owned by this session and project.",
    parameters: Type.Object({
      target: DeleteTargetParameters,
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          ((parameters.target as Static<typeof DeleteTargetParameters>).kind === "all"
            ? active.operations.removeAll
            : active.operations
                .remove((parameters.target as { readonly kind: "one"; readonly id: string }).id)
                .pipe(Effect.map((loop) => [loop]))
          ).pipe(
            Effect.tap(() => refreshStatus(active)),
            Effect.map((removed) =>
              toolResult(`Deleted ${removed.length} loop${removed.length === 1 ? "" : "s"}.`),
            ),
          ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "loop_list",
    label: "List Loops",
    description: "List all loops visible to this Pi session.",
    parameters: Type.Object({}),
    execute() {
      return run(
        withSession(pi, (active) =>
          active.operations.list.pipe(
            Effect.map((loops) =>
              toolResult(
                loops.length === 0 ? "No active loops" : loops.map(describeLoop).join("\n"),
              ),
            ),
          ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Arm Dynamic Loop",
    description: "Arm a dynamic loop that is awaiting the model's next wakeup decision.",
    parameters: Type.Object({
      loopId: Type.String(),
      delaySeconds: Type.Number({ minimum: 60, maximum: 3_600 }),
      reason: Type.String(),
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.operations
            .scheduleWakeup(parameters.loopId ?? "", parameters.delaySeconds ?? 0)
            .pipe(
              Effect.tap(() => refreshStatus(active)),
              Effect.map(() =>
                toolResult(
                  `Armed ${parameters.loopId ?? ""} in ${parameters.delaySeconds ?? 0}s: ${parameters.reason ?? ""}`,
                ),
              ),
            ),
        ),
      );
    },
  });

  pi.on("session_start", (_event, context) =>
    run(
      startSession(pi, context).pipe(
        Effect.catch((error) => notifyFailure(context, error)),
        Effect.asVoid,
      ),
    ),
  );
  pi.on("session_shutdown", () => {
    const active = sessions.get(pi as object);
    return active ? run(stopSession(pi, active)) : run(Effect.void);
  });
  pi.on("agent_start", () => {
    const active = sessions.get(pi as object);
    if (active) runDetached(active.scheduler.setBusy);
  });
  pi.on("agent_end", () => {
    const active = sessions.get(pi as object);
    if (active) runDetached(active.scheduler.setIdle);
  });
}
