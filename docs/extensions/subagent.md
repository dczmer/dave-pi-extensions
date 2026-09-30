# subagent

Delegate tasks to headless `pi --mode rpc` child processes with isolated
context windows, without leaving your primary session.

The parent session is the RPC client of each child, so anything that would
prompt in the child — a `ctx.ui.confirm` from an extension like
[pi-gate](./pi-gate.md), or the child's `contact_supervisor` tool — is
relayed to your primary session for approval, and running subagents stream
their most recent output line (truncated to 80 columns) as live status.

## The `subagent` tool

Two modes; provide exactly one per call.

**Single mode** — one child process:

```json
{ "agent": "worker", "task": "List the files in /tmp", "cwd": "/optional/dir" }
```

**Parallel mode** — one child process per task, all concurrent (max 8 tasks,
4 at a time); the tool blocks until every child finishes:

```json
{
  "tasks": [
    { "agent": "worker", "task": "Summarize src/" },
    { "agent": "worker", "task": "Summarize test/", "cwd": "/other/project" }
  ]
}
```

Optional parameters:

- `agentScope` (`user` | `project` | `both`, default `both`) — which agent
  directories to search.
- `cwd` — working directory for the child process (defaults to the current
  session's cwd).

Model selection: an agent's own `model` frontmatter wins; otherwise the
child inherits the parent session's model and thinking level.

## Agents

Agents are markdown files with YAML frontmatter:

```markdown
---
name: reviewer
description: Reviews diffs for correctness and style
model: anthropic/claude-sonnet-4-5
tools: read, grep, bash
---

You are a code reviewer. ...
```

| Field         | Required | Meaning                                            |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | Name used in the tool call.                        |
| `description` | yes      | Shown to the orchestrating model.                  |
| `tools`       | no       | Tool allowlist (comma string or array).            |
| `model`       | no       | Model override; unset inherits the parent's model. |

The body becomes the child's appended system prompt.

### Discovery and precedence

Three tiers, searched in order so later tiers override earlier ones on name
collision — **project > user > bundled**:

1. Bundled with this extension (`worker`).
1. Global: `~/.pi/agent/agents/`.
1. Project: nearest `.pi/agents/`, walking up from the session cwd.

Malformed agent files are skipped without failing discovery.

### Untrusted projects

Project agents are repo-controlled, so when a tool call references a
project-sourced agent and the project is not trusted, you get a one-shot
confirmation before anything spawns. When the parent session has no
dialog-capable UI, the call is refused with an error instead — the
confirmation cannot be shown, so the gate fails closed.

## Approval relay

Child dialogs (`confirm`, `select`, `input`, `editor`) arrive in the primary
session as ordinary pi dialogs; your answer is sent back to the child, which
was blocked waiting for it. With several parallel children, their dialogs
queue in the TUI one at a time and each child blocks until its dialog is
answered.

When the parent session itself has no UI (e.g. it is also headless),
relayed dialogs are answered immediately with a cancellation so children
never hang.

`contact_supervisor` is a child-only tool (injected into every child via a
companion extension) that lets a blocked subagent ask you a free-form
question. Dismissing the question tells the child to proceed with its best
judgment.

A child process never registers the `subagent` tool itself — no nesting.

## Live progress

While a subagent runs, the collapsed tool result updates with its most
recent output line (text deltas from the active block, or a synthesized
`→ tool args` line for tool calls), and the footer shows a `subagent` status
entry. Both clear/resolve when the run finishes.

## Limits and tuning

Constants in `extensions/subagent/index.ts`:

- `MAX_PARALLEL_TASKS = 8` — tasks accepted in one parallel call.
- `MAX_CONCURRENCY = 4` — child processes running at once.
- `PER_TASK_OUTPUT_CAP = 50 KiB` — per-task output cap; overflow is
  truncated with a note (full output is preserved in tool details).

Aborting the tool call sends an `abort` RPC command to each child, then
SIGTERM, then SIGKILL after 5 seconds.
