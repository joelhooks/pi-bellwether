# Bellwether 🐏🔔

Bellwether (`@joelhooks/pi-bellwether`) is the owned Pi package for generic Herdr runtime control.

It replaces the loaded `pi-herdr` fork after a separate settings cutover. The fork remains rollback source. Bellwether does not depend on or edit it.

## Runtime

Bellwether keeps Pi startup side-effect free. It resolves the Herdr socket only when a tool or command runs.

- Effect 4.0.0-beta.99 owns socket path resolution, one newline-delimited JSON request per socket, Schema decoding, typed errors, timeouts, interruption, and cleanup.
- XState 5.32.5 owns each watch lifecycle: `[gated ->] starting -> running -> matched | timedOut | targetGone | failed | cancelled`.
- Pi runs tool calls in parallel, and Herdr `agent.wait` returns at once for a state the agent already holds. An `agent_state` watch started beside its own prompt would match the previous task's idle state. Bellwether announces prompt calls when the assistant message ends, holds such a watch in `gated` until the prompt proves `working`, and fails it with `prompt_unproven` when proof never arrives.
- Each watch owns one direct Herdr wait socket. Watches do not shell out, spawn `herdr`, or pool connections.
- Agent-state watches also use bounded one-request `agent.get` probes every five seconds. A crashed TUI that returns to a live shell settles as `targetGone` even when Herdr emits no release event.
- Active watches render in a compact Pi widget with a live spinner, phase, target, and elapsed time. The widget hides when no watch is active.
- Inside a Herdr pane, active watches also drive the Herdr sidebar under source `user:bellwether.v1` with a three-minute lease: pane `$wait` (for example `⏳ reviewer · 4m`), workspace `$agents` (other agents by state), and workspace `$needs` (blocked agent names). Herdr merges tokens across sources, so Bellwether clears only its own pane token and lets workspace tokens expire. No request is sent while no watch is active. Add `["$wait"]` to `ui.sidebar.agents.rows` to show it.
- Herdr `error.code` determines timeout and target-loss states. Error prose does not.

`herdr_ping_wait` remains an explicit degraded crash and turn fallback. It is the only child-process wait path. `herdr_watch` never calls it.

## Structured tools

### `herdr_layout`

Actions:

- `current`, `overview`
- `workspace_list`, `workspace_create`, `workspace_focus`, `workspace_rename`
- `tab_list`, `tab_create`, `tab_focus`
- `pane_list`, `pane_layout`, `pane_split`

`overview` returns one bounded snapshot for an explicit workspace or the caller's current workspace. It includes caller identity, scoped panes and agents, and session-owned active watches tied to those panes. Each list returns at most 64 entries with total, returned, and omitted counts. A failed section appears in `partialFailures`; Bellwether never substitutes a globally focused workspace for a missing caller.

### `herdr_pane`

Actions: `get`, `rename`, `run`, `read`, `send_text`, `send_keys`, `close`.

`rename` changes the pane display label. Pass `clearLabel: true` to clear it. Agent identity naming remains a separate `herdr_agent rename` action.

There is no `wait_output` action. `close` requires `confirm: true` and refuses the pane that hosts the current Pi process.

### `herdr_agent`

Actions: `list`, `get`, `start`, `prompt`, `read`, `send_keys`, `focus`, `rename`.

Agent startup uses `timeoutSeconds`; `120` means two minutes. There is no ambiguous public `timeout` field. Herdr's direct `agent.start` response may confirm `interactive_ready: true`; only then does Bellwether report readiness as `proven`. Otherwise it reports the launch as submitted with readiness `unknown`, preserving `launch_pending`, `interactive_ready`, agent state, and stable identity in details.

There is no public `wait` action or `wait` parameter. `prompt` first resolves the target to its stable pane ID, then performs a bounded delivery handshake. Bellwether asks Herdr for `working` state with one absolute 30-second wall-clock deadline. A successful response is proof that Herdr observed the agent alive and working. If the target is already working, Bellwether submits atomically without asking Herdr to wait for a later turn transition; the prompt response must still report working. This avoids a false timeout while a long current turn queues the prompt. Herdr 0.7.5 can return `agent_prompt_stalled` after five seconds even when Pi starts working just after its fixed gate. Bellwether then spends only the unused part of the original 30-second deadline on `agent.wait`, without resubmitting the prompt. If neither path observes `working`, the call returns a timeout. It does not wait for completion and starts no watch.

Start and prompt failures return `isError: true` with cloneable details: the primary Herdr error, failed stage, known pane identity, and prompt submission state. Bellwether makes at most one extra `pane.read` diagnostic request with a 1.5-second client deadline. Evidence is ANSI-stripped and capped at 12 lines / 2 KiB. Terminal evidence is marked `UNTRUSTED`; a diagnostic failure never replaces the primary error. An aborted call performs no further diagnostic I/O.

### `herdr_watch`

Actions: `start`, `list`, `status`, `cancel`.

`list` returns active watches only. Add `history: true` to include the retained terminal receipts. `status` still retrieves a finished watch by ID.

Status and wake text include the target, failure code, and observed agent state or terminal match. Terminal evidence prefers the matched line and is limited to 12 lines / 2 KiB, with ANSI controls stripped and truncation marked. Full structured receipts remain in `details`. Read more output only when the excerpt is insufficient; an observed state or matching line does not prove task completion.

Initial kinds:

- `agent_state`
- `pane_output`

`start` returns a cloneable running receipt immediately. The public timeout field is `timeoutSeconds`; `7200` means two hours. Bellwether converts seconds to Herdr milliseconds once at the extension boundary. Bellwether exposes no ambiguous public `timeout` field. Wake policies are `agent`, `notify`, and `silent`. Agent-state watches race the event-driven wait against a five-second liveness probe. Explicit `agent_not_found`, `agent_not_running`, or identity replacement settles as `targetGone`; transient probe failures do not override the wait. Cancel and non-reload `session_shutdown` close exact owned sockets and suppress late wakes. Bellwether stops terminal actors and retains only the newest 64 terminal receipts per session.

`/reload` is different: Bellwether writes one versioned suspension entry into the current Pi branch, closes its exact sockets and fallback child processes, then restores active waits in the new extension instance. Absolute deadlines do not restart. Only `reason: "reload"` restores them automatically; new, resumed, and forked sessions never revive stale waits. The newest suspension entry is authoritative, including an empty or malformed one.

`/quit` writes the same suspension entry. After a process restart against the same session file (`pi --session <file>`), `/herdr-resume` restores the newest entry on request: it skips waits whose absolute deadline already passed and waits that are already active, and it never runs by itself. Run it before the first `/reload` in the new process, because a reload writes a fresh (possibly empty) entry that becomes the newest.

On every non-reload start Bellwether counts pre-fix intercom presence entries on the branch (versions before 1.2.1 recorded every `capability` and `binding` announcement). At 1,000 or more it prints one warning naming `scripts/strip-intercom-chatter.mjs`, which drops those entries, re-links the id/parentId tree, verifies it, and backs the file up before rewriting. Quit the owning Pi process first; a live process keeps the old entries in memory.

The approved first cut intentionally supports only `agent_state` and `pane_output`. `workflow_receipt` is not a watch kind. Intercom can carry a compact workflow-receipt hint, but consumers must reread `herdr-workflow` as durable authority. Bellwether has no workflow-watch adapter. Add one only when a concrete consumer and result contract exist.

## Wakes

Watch and degraded ping-wait settlements wake the agent through one router (`src/wake.ts`).

- Wakes that settle while the agent runs are held until `agent_end`, then sent as one follow-up about 250 ms later. A burst of idle-time settlements also merges. Several wakes arrive as `bellwether-wakes` with every receipt in the content and `details.wakes`; a single wake keeps its original custom type and details.
- A held wake is delayed at most five minutes if an `agent_end` is missed. It is never dropped.
- Bellwether first offers the follow-up to pi-until's session arbiter on `pi-until:follow-up`. When pi-until accepts, it serializes the wake with its own follow-ups and Pi receives `details: { followUpId, receipt }`. Otherwise Bellwether sends the follow-up directly.
- Session shutdown delivers held wakes directly, because pi-until may be stopping its queue in the same shutdown.
- A worker's own intercom report supersedes its state watch. Each agent-state watch learns the target's Pi session from its liveness probe. If that session messages the owner after the watch starts, a later `idle` or `done` match is recorded as a quiet receipt (`quiet: "reported"`) and does not wake the agent. `blocked`, `targetGone`, `timedOut`, and failures still wake it. On 2026-09-25, 124 of 217 fleet watch wakes in 36 hours were no-ops, most after the worker had already reported.
- Cancelling a watch withdraws its wake if the wake is still held behind the current run.

## Pi intercom

Bellwether reads pi-intercom; it does not publish on it. It registers `bellwether/directory/v1` with `ownerEligible: false` only to list live intercom sessions.

- `herdr_layout overview` adds `piSessionId` to each Pi agent, parsed from Herdr's `agent_session` path. pi-intercom uses the same ID, so `intercom send` can target it directly.
- When pi-intercom is connected, each Pi agent also gets `intercom: { name, status }`, or `intercom: null` when that session is not reachable. Details report `intercom: "connected" | "unavailable"`. The session list read is bounded to 1.5 seconds.
- Bellwether versions up to 1.3 broadcast capability, binding, watch, wake, and workflow-receipt hints on `bellwether/herdr/v1`. Nothing consumed them, and recording them bloated session files. That traffic is gone. The startup chatter warning still detects old entries.
- Missing or unsupported pi-intercom leaves every Herdr tool unchanged.

## Slash commands

Bellwether keeps bounded human commands:

- `/herdr-status`
- `/herdr-agents`
- `/herdr-read <agent target>`
- `/herdr-focus <agent target>`
- `/herdr-stop <agent target>`
- `/herdr-resume` — restore waits from the newest suspension entry after a process restart; expired waits are skipped.

The old split send/submit and combined start commands are gone.

## Install and smoke test

```bash
pi install git:github.com/joelhooks/pi-bellwether
PI_OFFLINE=1 pi -e /path/to/pi-bellwether --help
```

## Settings cutover

Do not change global Pi settings while building or reviewing this package.

After parity review, replace the `pi-extensions/packages/pi-herdr` entry in `~/.pi/agent/settings.json` with the reviewed Bellwether checkout or package reference. Start a fresh Pi session, verify the four structured tools, run one bounded read and one cancellable watch, then keep the fork unloaded as rollback.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
npm run pack:check
npm audit --omit=dev
pi-notes brain check
```
