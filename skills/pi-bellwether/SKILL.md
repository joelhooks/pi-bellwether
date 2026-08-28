---
name: pi-bellwether
description: Control Herdr workspaces, tabs, panes, coding agents, and non-blocking direct-socket watches from Pi. Use when Joel explicitly asks to inspect or control Herdr, create pane topology, prompt a Herdr agent, read output, or arm an agent-state or pane-output watch.
disable-model-invocation: true
---

# Pi Bellwether 🐏🔔

Bellwether owns generic Herdr control. `herdr-workflow` owns durable workflow truth.

## Flow

1. Use `herdr_layout` to inspect or create topology.
2. Use `herdr_agent start` only with an existing available pane.
3. Use `herdr_agent prompt` to submit one prompt. It returns after Herdr observes `working` state, or fails with a bounded proof-of-life error.
4. Arm `herdr_watch` only when a separate external condition matters.
5. Inspect the terminal receipt and target output before claiming completion.
6. Cancel watches that no longer matter.

## Tools

- `herdr_layout`: current, workspace, tab, pane list/layout/split actions.
- `herdr_pane`: get, run, read, send text/keys, guarded close.
- `herdr_agent`: list, get, start, prompt, read, send keys, focus, rename.
- `herdr_watch`: start, list, status, cancel for `agent_state` and `pane_output`.

Public deadlines use `timeoutSeconds`. Bellwether converts them to protocol milliseconds at the boundary. Never pass `timeout`.

The public action tools contain no wait action or wait parameter. `herdr_agent prompt` resolves the target to its stable pane ID, then performs one internal delivery handshake with Herdr: wait for `working`, one absolute 30-second wall-clock deadline. An already-working target uses atomic submission plus the prompt response's working state; Bellwether does not wait for a later turn transition. Herdr 0.7.5 has a fixed five-second stall gate for non-working targets. If that gate fires, Bellwether uses only the unused part of the original deadline on `agent.wait`, without sending the prompt again. A timeout means neither proof path observed `working`. Success proves liveness, not completion. It starts no watch.

## Watch receipts

`herdr_watch start` returns a running receipt immediately. Use `timeoutSeconds` for a deadline; `7200` means two hours. Never pass an ambiguous `timeout` field. Its XState lifecycle is:

```text
starting -> running -> matched | timedOut | targetGone | failed | cancelled
```

Wake policies:

- `agent`: one follow-up turn at most.
- `notify`: UI notification only.
- `silent`: receipt only.

Agent-state watches re-probe `agent.get` every five seconds. If a worker crashes back to a live shell without a Herdr release event, the watch settles as `targetGone` and wakes according to policy. A lifecycle match is diagnostic. It does not prove a worker finished its task.

## Close guard

Read or inspect the pane first. `herdr_pane close` requires `confirm: true` and refuses the pane that hosts Pi.

## Intercom

Bellwether publishes compact live hints through `bellwether/herdr/v1` when pi-intercom supports `extension-bus-v1`. Targeted wake hints trigger one hidden typed Pi follow-up. Workflow-receipt hints only tell the receiver to reread durable `herdr-workflow` state. Herdr and `herdr-workflow` remain authority.

## Degraded fallback

Use `herdr_ping_wait` only for crash or turn events that the direct watch kinds cannot express. It starts a child process. `herdr_watch` does not.
