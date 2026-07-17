# pi-loop

Effect-based temporal loops for Pi.

```sh
pi install npm:@yansircc/pi-loop
```

## Commands

```text
/loop 7m inspect the build       # execute now, then every exact 7 minutes
/loop monitor the deployment     # model-paced dynamic loop
/loop-list
/loop-kill <id|all>
```

Fixed intervals are elapsed durations, not approximated cron expressions. Dynamic loops execute
once, enter `AwaitingArm`, and continue only when the model calls:

```text
schedule_wakeup { loopId, delaySeconds, reason }
```

## Model tools

- `cron_create`: recurring calendar cron or one-shot prompt.
- `cron_delete`: cancel by id or `all`.
- `cron_list`: list active loops.
- `schedule_wakeup`: arm one dynamic loop for 60–3600 seconds.

`cron_create` accepts a five-field cron expression, prompt, `recurring`, `durable`, and optional
label. Cron uses an explicit IANA timezone and standard day-of-month/day-of-week OR semantics.
Missed recurring occurrences coalesce into one claim.

## State and delivery

Session loops are stored as versioned custom entries in the owning Pi session. Forked sessions do
not inherit them. Durable cron and one-shot loops are stored in `.pi-loop.json`. One PID lease owns
durable mutation. Followers continue running session loops and retry ownership while draining project
loops, so one live follower reloads the durable file and takes over after the previous owner exits.
Completed, expired, and cancelled loops are removed; `Stopped` is not a persisted phase.

When the extension runs inside pi-web it also exposes a structured multi-loop status and a typed
control command. pi-web keeps a session runtime alive while at least one loop exists. If pi-web is
stopped, no loop runs; reopening the session restores state and coalesces an overdue occurrence.

Delivery is at-most-once after claim: durable state commits before Pi receives the prompt. A failed
commit emits no occurrence; a Pi failure after commit is logged and is not retried.

Project overrides belong in `.pi-loop.config.json`:

```json
{
  "maxLoops": 50,
  "recurringMaxAgeMs": 604800000,
  "recurringJitterFraction": 0.5,
  "recurringJitterCapMs": 1800000,
  "checkIntervalMs": 1000,
  "durableFilePath": ".pi-loop.json",
  "timeZone": "Asia/Shanghai"
}
```

## Development

```sh
pnpm install
pnpm run verify
pnpm run pi:pack
```

The package gate builds one self-contained Node ESM entry, packs it, extracts it without installing
dependencies, and loads it through Pi's real extension loader.

## Releases

A Loop release is declared by a tracked JSON changeset under `release/changes/`. The entry names
`@yansircc/pi-loop` and a `patch`, `minor`, or `major` bump. A push without a Loop changeset does not
change or publish its version. CI owns the version commit, exact archive, package tag, and registry
integrity proof.
