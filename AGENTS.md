# AGENTS.md

## Project shape

Bellwether 🐏🔔 (`@joelhooks/pi-bellwether`) is the owned Pi package for generic Herdr runtime control.

Product-specific workflow policy belongs downstream. `herdr-workflow` owns durable leases, generations, claims, and receipts.

## Runtime rules

- Keep extension startup side-effect free. Resolve sockets only during commands, tools, or explicit watch starts.
- Use one newline-delimited JSON request per Herdr socket. Never pool Herdr sockets.
- Effect 4.0.0-beta.99 owns path resolution, framing, Schema decoding, typed errors, timeouts, interruption, and socket cleanup.
- XState 5.32.5 owns watch lifecycle only: `starting -> running -> matched | timedOut | targetGone | failed | cancelled`.
- Each `herdr_watch` owns one direct wait socket. It never shells out or starts a child process.
- `herdr_agent prompt` is a bounded delivery handshake. Resolve a stable pane ID, submit once, and require Herdr-observed `working` state within one 30-second proof deadline. A stall recovery may use `agent.wait`; it must never resubmit or wait for completion. The public schema exposes no wait options, and prompt starts no watch.
- Use Herdr `error.code`. Do not classify errors from message text.
- Cancel and `session_shutdown` close exact owned sockets and suppress late wakes.
- Tool `details` must remain structured-clone-safe plain data.
- Keep `herdr_ping_wait` visibly degraded and isolated. Only explicit `action=start` may spawn its child.

## Intercom

Register `bellwether/herdr/v1` through `pi.events`. Do not statically import pi-intercom at runtime.

Use `ownerEligible: false`. Publish compact capability, binding, and watch hints only. Prompts, output, transcripts, workflow bodies, and ownership state stay off the bus.

Lost bus traffic may delay a hint. It cannot lose or invent Herdr or workflow truth.

## Public tools

- `herdr_layout`
- `herdr_pane`
- `herdr_agent`
- `herdr_watch`

`herdr_ping_wait` is a separate degraded fallback.

No LLM schema may expose `wait`, `wait_output`, or `prompt_settle`.

## Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
npm run pack:check
npm audit --omit=dev
pi-notes brain check
```
