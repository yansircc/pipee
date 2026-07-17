# pi-loop

Agent-first scheduling tools for Pi. Users describe recurring or delayed work conversationally; the
agent creates and manages typed loops. There are no slash commands or Web control buttons.

## Tools

- `loop_create`: create an interval, cron, one-shot, or dynamic loop.
- `loop_update`: replace a loop's prompt, label, or complete schedule.
- `loop_pause` / `loop_resume`: change whether a loop may run.
- `loop_run_now`: run one enabled loop immediately.
- `loop_delete`: delete one loop or all visible loops.
- `loop_list`: inspect the current loops.
- `schedule_wakeup`: arm the next wakeup for a dynamic loop.

Session-retained loops disappear with their owning Pi session. Project-retained loops survive and
are leased by one live Pi process. Dynamic loops are session-retained because their next wakeup is
part of the active agent conversation.

Pi Web renders the structured loop projection as read-only status. All mutations go through the
typed Agent tools.

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
