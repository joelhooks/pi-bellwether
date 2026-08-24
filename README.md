> [!IMPORTANT]
> Archived on 2026-08-24. The active Herdr control surface now lives in `pi-herdr` 1.0.0 and the Herdr workflow control plane. `herdr-pings` remains the degraded crash and turn fallback.

# Bellwether 🐏🔔

Bellwether is a Pi package for managing [Herdr](https://herdr.dev) agents, panes, and runtime sessions from Pi.

This is deliberately generic runtime plumbing. Product-specific loop control should depend on this package or adapt its commands/tools, not bury Herdr control inside a loop-specific extension.

## Install

Install from GitHub:

```bash
pi install git:github.com/joelhooks/pi-bellwether
```

Or use a local checkout:

```bash
pi install /path/to/pi-bellwether
```

For a one-off smoke test without installing:

```bash
PI_OFFLINE=1 pi -e /path/to/pi-bellwether --help
```

## Slash commands

- `/herdr-status` — show Herdr client/server status.
- `/herdr-agents [--panes]` — list detected Herdr agents, optionally with panes.
- `/herdr-start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down] [--env KEY=VALUE] [--focus|--no-focus] -- <cmd ...>` — start a managed agent/process.
- `/herdr-send <target> <message>` — send literal text to a Herdr agent target.
- `/herdr-submit <target>` — press Enter in the target agent's pane.
- `/herdr-read <target> [--lines N] [--source visible|recent|recent-unwrapped] [--ansi]` — read recent output.
- `/herdr-focus <target>` — focus an agent target.
- `/herdr-stop <target>` — close the target agent's pane after confirmation.

Targets are whatever `herdr agent` accepts: terminal ids, pane ids, unique agent names, detected/reported labels, and legacy pane ids.

## LLM tools

- `herdr_status`
- `herdr_list_agents`
- `herdr_start_agent`
- `herdr_send_message`
- `herdr_submit`
- `herdr_read_agent`
- `herdr_focus_agent`
- `herdr_stop_agent`
- `herdr_ping_wait`

`herdr_ping_wait` starts a session-owned background wait for the next event from one or more Herdr pane spools. Its `start` action returns immediately. When an event arrives, it wakes Pi with a follow-up receipt. It also supports `list`, `status`, and `cancel`. The external [`herdr-ping-wait`](https://github.com/joelhooks/herdr-pings) executable must be installed first.

Long waits belong in `herdr_ping_wait`, not a blocking tool call or shell command. Bounded control operations such as status, list, read, focus, send, start, and stop remain synchronous. A `turn_ended` event means the agent settled; it does not prove the task finished.

`herdr_stop_agent` requires `confirm: true` because it closes a terminal pane. Read/list first, stop second. FFS, don't let the robot blindly close terminals.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
pi-notes brain check
```

The extension uses `execFile`, not shell strings, so command arguments are passed without shell injection. It lazily resolves the `herdr` binary when a command/tool runs, so Pi startup does not fail on machines without Herdr installed.
