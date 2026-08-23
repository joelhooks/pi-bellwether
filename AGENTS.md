# AGENTS.md

## Project shape

Bellwether 🐏🔔 (`@joelhooks/pi-bellwether`) is a Pi package that exposes generic Herdr runtime management as slash commands and LLM tools.

Generic Herdr control belongs here. Product-specific loop behavior belongs in downstream loop extensions that depend on or adapt this package.

## Extension rules

- Keep startup side-effect free. Do not start Herdr or background daemons during extension load.
- Start long-lived waits only from `herdr_ping_wait({ action: "start" })`. Return immediately, track the exact child process, and abort it during `session_shutdown` or explicit cancellation.
- Keep bounded Herdr control calls synchronous. Any future `agent wait`, `prompt --wait`, or `pane wait-output` tool surface must use the same background-watch contract instead of blocking a Pi turn.
- Resolve the `herdr` and `herdr-ping-wait` binaries lazily inside command/tool execution.
- Use `execFile` with argv arrays, not shell command strings.
- Tool `details` must stay cloneable plain data.
- Read/list before send/stop when target identity is unclear.
- Stop/close stays guarded: slash command confirmation and `herdr_stop_agent({ confirm: true })`.

## Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
pi-notes brain check
```
