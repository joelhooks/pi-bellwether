---
name: pi-herdr
description: Manage Herdr agents and panes from Pi. Use when listing Herdr agents, reading pane output, sending/submitting text to another agent, focusing panes, starting managed Herdr processes, or safely closing Herdr panes.
---

# Pi Herdr

Use this skill when Pi needs to coordinate with Herdr-managed terminal agents/panes.

## Operating rules

- Check `herdr_status` first when Herdr commands fail, especially for client/server protocol mismatch.
- Use `herdr_list_agents` before targeting an agent unless the user gave an exact terminal id, pane id, or unique agent label.
- Use `herdr_read_agent` before sending follow-up text if you are not sure what the target is doing.
- `herdr_send_message` writes literal text only. Use `herdr_submit` afterward to press Enter.
- `herdr_stop_agent` closes a terminal pane. Only call it when the user explicitly asks to stop/close the target, and set `confirm: true` only after checking the target.
- Prefer stable Herdr ids (`terminal_id` or `pane_id`) over broad names like `pi`, because multiple Pi agents are common.

## Slash commands

- `/herdr-status`
- `/herdr-agents [--panes]`
- `/herdr-start <name> -- <cmd ...>`
- `/herdr-send <target> <message>`
- `/herdr-submit <target>`
- `/herdr-read <target> [--lines N] [--source visible|recent|recent-unwrapped] [--ansi]`
- `/herdr-focus <target>`
- `/herdr-stop <target>`

## Tool flow examples

Send a prompt to a known target:

1. `herdr_read_agent({ target })`
2. `herdr_send_message({ target, message })`
3. `herdr_submit({ target })`

Stop a target safely:

1. `herdr_list_agents({ includePanes: true })`
2. `herdr_read_agent({ target, lines: 20 })`
3. `herdr_stop_agent({ target, confirm: true })`
