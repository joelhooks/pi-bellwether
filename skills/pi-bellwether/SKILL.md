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
3. Use `herdr_agent prompt` to submit one prompt. It returns after Herdr accepts the prompt.
4. Arm `herdr_watch` only when a separate external condition matters.
5. Inspect the terminal receipt and target output before claiming completion.
6. Cancel watches that no longer matter.

## Tools

- `herdr_layout`: current, workspace, tab, pane list/layout/split actions.
- `herdr_pane`: get, run, read, send text/keys, guarded close.
- `herdr_agent`: list, get, start, prompt, read, send keys, focus, rename.
- `herdr_watch`: start, list, status, cancel for `agent_state` and `pane_output`.

The action tools contain no wait path. `herdr_agent prompt` starts no watch.

## Watch receipts

`herdr_watch start` returns a running receipt immediately. Its XState lifecycle is:

```text
starting -> running -> matched | timedOut | targetGone | failed | cancelled
```

Wake policies:

- `agent`: one follow-up turn at most.
- `notify`: UI notification only.
- `silent`: receipt only.

A lifecycle match is diagnostic. It does not prove a worker finished its task.

## Close guard

Read or inspect the pane first. `herdr_pane close` requires `confirm: true` and refuses the pane that hosts Pi.

## Intercom

Bellwether publishes compact live hints through `bellwether/herdr/v1` when pi-intercom supports `extension-bus-v1`. Targeted wake hints trigger one hidden typed Pi follow-up. Workflow-receipt hints only tell the receiver to reread durable `herdr-workflow` state. Herdr and `herdr-workflow` remain authority.

## Degraded fallback

Use `herdr_ping_wait` only for crash or turn events that the direct watch kinds cannot express. It starts a child process. `herdr_watch` does not.
