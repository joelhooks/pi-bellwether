# Bellwether 🐏🔔

Bellwether (`@joelhooks/pi-bellwether`) is the owned Pi package for generic Herdr runtime control.

It replaces the loaded `pi-herdr` fork after a separate settings cutover. The fork remains rollback source. Bellwether does not depend on or edit it.

## Runtime

Bellwether keeps Pi startup side-effect free. It resolves the Herdr socket only when a tool or command runs.

- Effect 4.0.0-beta.99 owns socket path resolution, one newline-delimited JSON request per socket, Schema decoding, typed errors, timeouts, interruption, and cleanup.
- XState 5.32.5 owns each watch lifecycle: `starting -> running -> matched | timedOut | targetGone | failed | cancelled`.
- Each watch owns one direct Herdr wait socket. Watches do not shell out, spawn `herdr`, or pool connections.
- Herdr `error.code` determines timeout and target-loss states. Error prose does not.

`herdr_ping_wait` remains an explicit degraded crash and turn fallback. It is the only child-process wait path. `herdr_watch` never calls it.

## Structured tools

### `herdr_layout`

Actions:

- `current`
- `workspace_list`, `workspace_create`, `workspace_focus`
- `tab_list`, `tab_create`, `tab_focus`
- `pane_list`, `pane_layout`, `pane_split`

### `herdr_pane`

Actions: `get`, `run`, `read`, `send_text`, `send_keys`, `close`.

There is no `wait_output` action. `close` requires `confirm: true` and refuses the pane that hosts the current Pi process.

### `herdr_agent`

Actions: `list`, `get`, `start`, `prompt`, `read`, `send_keys`, `focus`, `rename`.

There is no `wait` action or `wait` parameter. `prompt` sends one bounded `agent.prompt` request with no wait options. It starts no implicit watch.

### `herdr_watch`

Actions: `start`, `list`, `status`, `cancel`.

Initial kinds:

- `agent_state`
- `pane_output`

`start` returns a cloneable running receipt immediately. Wake policies are `agent`, `notify`, and `silent`. Cancel and `session_shutdown` close exact owned sockets and suppress late wakes. Bellwether stops terminal actors and retains only the newest 64 terminal receipts per session.

The approved first cut intentionally supports only `agent_state` and `pane_output`. `workflow_receipt` is not a watch kind. Intercom can carry a compact workflow-receipt hint, but consumers must reread `herdr-workflow` as durable authority. `src/watch.ts` keeps a typed future adapter seam without duplicating workflow leases or state.

## Pi intercom

Bellwether optionally registers `bellwether/herdr/v1` through `pi.events` and pi-intercom's `extension-bus-v1` contract.

- Registration uses `ownerEligible: false`.
- Traffic contains only capability, pane/session binding, watch lifecycle, targeted wake, and workflow-receipt hints.
- Traffic contains no prompts, terminal output, transcripts, socket paths, or workflow bodies.
- Recipients filter target session/pane and deduplicate the newest 256 event IDs.
- Join, leave, presence, and reconnect events republish bindings and active watch hints.
- A targeted wake invokes one injected local callback. Pi has no wake-only primitive, so the adapter emits a hidden typed custom follow-up (`bellwether-intercom-wake`) to trigger the turn. This custom message enters Pi context but carries only event, source session, and optional watch IDs.
- Missing or unsupported pi-intercom leaves local Herdr tools and watches unchanged.

Intercom messages are hints. Herdr and `herdr-workflow` remain authority.

## Slash commands

Bellwether keeps bounded human commands:

- `/herdr-status`
- `/herdr-agents`
- `/herdr-read <agent target>`
- `/herdr-focus <agent target>`
- `/herdr-stop <agent target>`

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
