# Bellwether 🐏🔔

Bellwether is a Pi package for managing [Herdr](https://herdr.dev) agents, panes, and runtime sessions from Pi.

The mascot is the bell sheep: one loud little ram leading the flock instead of a pile of anonymous terminals.

This is deliberately generic runtime plumbing. Product-specific loop control should depend on this package or adapt its commands/tools, not bury Herdr control inside a loop-specific extension.

## Why not `pi-herdr`?

There is already prior art using that name:

- [`@ogulcancelik/pi-herdr`](https://github.com/ogulcancelik/pi-extensions/tree/HEAD/packages/pi-herdr)
- [`@weshipwork/pi-herdr`](https://github.com/WeShipWork/threeonefour/tree/main/packages/pi-herdr)

So this package uses a distinct identity: **Bellwether 🐏🔔**.

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

`herdr_stop_agent` requires `confirm: true` because it closes a terminal pane. Read/list first, stop second. FFS, don't let the robot blindly close terminals.

## Prior-art ideas worth stealing next

The existing `pi-herdr` packages have sharper workflow primitives than this first Bellwether cut:

- **Single action tool**: both prior-art packages expose one `herdr` tool with an `action` enum. Bellwether currently exposes several smaller tools. That is clearer, but noisier.
- **Pane aliases**: prior art stores friendly aliases like `server` or `reviewer` in tool result details and reconstructs them on session/tree changes.
- **Atomic `run`**: prior art prefers one action that sends text plus Enter atomically instead of `send` + `submit`.
- **Watch/wait primitives**: prior art wraps `herdr wait output` and agent-status waits for readiness/finished states.
- **Inside-Herdr guard**: prior art only registers tools when `HERDR_ENV` and `HERDR_PANE_ID` exist. Bellwether intentionally works as a general Herdr controller, even from outside a Herdr pane, but this may need a config flag later.

## Development

```bash
npm install --ignore-scripts
npm run check
npm run smoke
pi-notes brain check
```

The extension uses `execFile`, not shell strings, so command arguments are passed without shell injection. It lazily resolves the `herdr` binary when a command/tool runs, so Pi startup does not fail on machines without Herdr installed.
