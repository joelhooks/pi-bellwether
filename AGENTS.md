# AGENTS.md

## Project shape

Bellwether 🐏🔔 (`@joelhooks/pi-bellwether`) is the owned Pi package for generic Herdr runtime control.

Product-specific workflow policy belongs downstream. `herdr-workflow` owns durable leases, generations, claims, and receipts.

## Runtime rules

- Keep extension startup side-effect free. Resolve sockets only during commands, tools, or explicit watch starts.
- Use one newline-delimited JSON request per Herdr socket. Never pool Herdr sockets.
- Effect 4.0.0-beta.99 owns path resolution, framing, Schema decoding, typed errors, timeouts, interruption, and socket cleanup.
- XState 5.32.5 owns watch lifecycle only: `[gated ->] starting -> running -> matched | timedOut | targetGone | failed | cancelled`.
- `gated` exists only for `agent_state` watches started while a same-session prompt is in flight (`src/prompt-gate.ts`). `message_end` announces prompt calls before any tool runs; `turn_end` settles calls that never executed. An unproven prompt to the watched target fails the watch with `prompt_unproven`.
- The sidebar reporter (`src/sidebar.ts`) is display-only. It sends no request while no watch is active, clears only its own pane `$wait`, and leaves shared workspace tokens to lease expiry.
- Each `herdr_watch` owns one direct wait socket. It never shells out or starts a child process.
- Optional watch `socketPath` routes the wait and probes to an externally managed Unix socket; persist it across reload/resume and classify a missing/refused forward as `failed`, never `targetGone`.
- `herdr_agent prompt` is a bounded delivery handshake. Resolve a stable pane ID, submit once, and require Herdr-observed `working` state within one 30-second proof deadline. A stall recovery may use `agent.wait`; it must never resubmit or wait for completion. The public schema exposes no wait options, and prompt starts no watch.
- Use Herdr `error.code`. Do not classify errors from message text.
- Cancel and non-reload `session_shutdown` close exact owned sockets and suppress late wakes. `/reload` and `quit` first persist active direct and degraded waits into a versioned branch entry, then close them. Only the replacement extension instance after `/reload` restores automatically, without extending deadlines. `/herdr-resume` is the one explicit restore path after a process restart: newest entry, expired and already-active waits skipped, never automatic. Session replacement writes nothing.
- Tool `details` must remain structured-clone-safe plain data.
- Keep `herdr_ping_wait` visibly degraded and isolated. Only explicit `action=start` may spawn its child.

## Wakes

Bellwether subscribes to `bellwether/pane-close/v1` at extension load without I/O or publishing. The payload is `{ paneId: string, terminalId?: string, reason: string, reply?: (result: { retired: string[] }) => void }`. Match local watches by stable pane ID, resolved named-agent pane, or terminal ID. Cancel active (including gated) matches through the watch registry with `pane closed by owner: <reason>` and withdraw held wakes; already-settled matches are retired when their wake is mailed or in flight. Reply synchronously with retired IDs. Ignore malformed payloads and log only a payload-free debug message. Delivered wakes cannot be recalled.

Every agent wake goes through `src/wake-record.ts`: send a signed `sh.mschf.agentgraph.wake` record to the live self Rat King name. pi-ratking owns urgency, batching, withdrawal, and delivery through pi-until. Without a live name or on send refusal/timeout, deliver one local follow-up. Cancel sends a `cancelled` record for a mailed watch id; local follow-ups cannot be withdrawn.

## Library exports

`package.json` `exports` lets downstream packages (Muster 🐑) import the generic modules as a library: `herdr-client`, `sidebar`, `wake-record`, and `watch`. Each maps to its `src/*.ts` file, which `files` already ships. Keep those modules free of product policy; a downstream package imports them and never the extension file. Bellwether never imports a downstream package. Changing an exported signature is a breaking change for Muster.

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
