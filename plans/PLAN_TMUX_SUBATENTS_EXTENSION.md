# Extension-Based Subagent Orchestration — Implementation Plan

## Overview

Create `tmux-subagent` extension Pi loads at startup. Extension registers a `subagent` tool LLM calls to spawn, manage, and coordinate subagents via tmux sessions. Extension handles lifecycle directly instead of delegating to bash scripts.

---

## Directory Structure

```
~/.pi/agent/extensions/tmux-subagent/
├── index.ts              # Main extension entry point
├── agents.ts             # Agent discovery (from subagent/ example)
├── types.ts              # Shared TypeScript interfaces
├── lib/
│   ├── tmux.ts           # Tmux session management
│   ├── spawn.ts          # Subagent spawning logic
│   ├── state.ts          # State file management
│   └── render.ts         # Custom TUI rendering
└── agents/               # Agent configuration files
    ├── backend.md
    ├── frontend.md
    └── reviewer.md
```

---

## Phase 1: Core Extension (`index.ts`)

Extension registers `subagent` tool with three modes: single, parallel, chain.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { discoverAgents } from "./agents.js";
import { spawnSubagent, listSubagents, sendToSubagent, killSubagent, getLogs } from "./lib/tmux.js";
import { renderSubagentCall, renderSubagentResult } from "./lib/render.js";

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent type to spawn" }),
  task: Type.String({ description: "Task description" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

export default function (pi: ExtensionAPI) {
  // Register /subagents command for management
  pi.registerCommand("subagents", {
    description: "List active subagents",
    handler: async (_args, ctx) => {
      const agents = await listSubagents();
      ctx.ui.notify(`Active subagents: ${agents.length}`, "info");
    },
  });

  // Register subagent tool
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn and manage subagents in isolated tmux sessions.",
      "Modes: single (agent+task), parallel (tasks[]), chain (sequential).",
      "Subagents run with isolated context, persist until killed.",
    ].join(" "),
    parameters: Type.Object({
      mode: StringEnum(["spawn", "list", "send", "logs", "kill"] as const),
      agent: Type.Optional(Type.String()),          // for spawn
      task: Type.Optional(Type.String()),           // for spawn
      agentId: Type.Optional(Type.String()),        // for send/logs/kill
      prompt: Type.Optional(Type.String()),         // for send
      tasks: Type.Optional(Type.Array(TaskSchema)), // for parallel spawn
      chain: Type.Optional(Type.Array(TaskSchema)), // for sequential spawn
      lines: Type.Optional(Type.Number({ default: 50 })), // for logs
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd);

      switch (params.mode) {
        case "spawn":
          if (params.tasks) {
            // Parallel mode
            const results = await Promise.all(
              params.tasks.map(t => spawnSubagent(t.agent, t.task, t.cwd, agents, signal))
            );
            return {
              content: [{ type: "text", text: formatParallelResults(results) }],
              details: { mode: "parallel", results },
            };
          }
          if (params.chain) {
            // Chain mode with {previous} interpolation
            let previous = "";
            const results = [];
            for (const step of params.chain) {
              const task = step.task.replace(/\{previous\}/g, previous);
              const result = await spawnSubagent(step.agent, task, step.cwd, agents, signal);
              results.push(result);
              previous = result.output;
              if (result.exitCode !== 0) break;
            }
            return {
              content: [{ type: "text", text: results[results.length - 1]?.output || "" }],
              details: { mode: "chain", results },
            };
          }
          // Single mode
          const result = await spawnSubagent(params.agent!, params.task!, undefined, agents, signal);
          return {
            content: [{ type: "text", text: result.output }],
            details: { mode: "single", result },
          };

        case "list":
          const active = await listSubagents();
          return {
            content: [{ type: "text", text: formatAgentList(active) }],
            details: { agents: active },
          };

        case "send":
          await sendToSubagent(params.agentId!, params.prompt!);
          return {
            content: [{ type: "text", text: `Sent to ${params.agentId}` }],
            details: { agentId: params.agentId, prompt: params.prompt },
          };

        case "logs":
          const logs = await getLogs(params.agentId!, params.lines);
          return {
            content: [{ type: "text", text: logs }],
            details: { agentId: params.agentId },
          };

        case "kill":
          await killSubagent(params.agentId!);
          return {
            content: [{ type: "text", text: `Killed ${params.agentId}` }],
            details: { agentId: params.agentId },
          };
      }
    },

    renderCall(args, theme, ctx) {
      return renderSubagentCall(args, theme);
    },

    renderResult(result, options, theme, ctx) {
      return renderSubagentResult(result, options, theme);
    },
  });
}
```

---

## Phase 2: Agent Discovery (`agents.ts`)

Same pattern as official `subagent/` example. Scans `~/.pi/agent/agents/` and `.pi/agents/` for markdown files with front-matter.

```typescript
export interface AgentConfig {
  name: string;
  source: "user" | "project";
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

export function discoverAgents(cwd: string, scope: "user" | "project" | "both" = "both"): AgentConfig[] {
  // Parse ~/.pi/agent/agents/*.md and .pi/agents/*.md
  // Extract front-matter (model, tools) and content (system prompt)
}
```

**Agent file format** (`agents/rust-expert.md`):
```markdown
---
model: claude-sonnet-4-20250514
tools: read,bash,edit
---

You are a Rust expert. Focus on memory safety and idiomatic patterns.
```

---

## Phase 3: Tmux Management (`lib/tmux.ts`)

Direct tmux control via `node:child_process`. No bash scripts—TypeScript manages sessions.

```typescript
import { spawn, exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const STATEDIR = path.join(os.homedir(), ".local/share/pi-subagent");

interface SubagentState {
  agentId: string;
  agentType: string;
  session: string;
  cwd: string;
  startTime: string;
  model?: string;
  pid?: number;
}

export async function spawnSubagent(
  agentType: string,
  task: string,
  cwd: string = process.cwd(),
  agents: AgentConfig[],
  signal?: AbortSignal
): Promise<{ agentId: string; output: string; exitCode: number }> {
  // Generate unique ID: <type>-<random>
  const suffix = Math.random().toString(36).slice(2, 7);
  const agentId = `${agentType}-${suffix}`;
  const session = `pi-sub-${agentId}`;
  const statedir = path.join(STATEDIR, agentId);

  await fs.mkdir(statedir, { recursive: true });

  // Find agent config
  const config = agents.find(a => a.name === agentType);
  
  // Build pi command
  const args = ["--no-interactive"];
  if (config?.model) args.push("--model", config.model);
  if (config?.tools) args.push("--tools", config.tools.join(","));
  if (config?.systemPrompt) {
    const promptFile = path.join(statedir, "prompt.txt");
    await fs.writeFile(promptFile, config.systemPrompt);
    args.push("--system-prompt-file", promptFile);
  }
  args.push("-p", task);

  // Spawn tmux session running pi
  const piCmd = `pi ${args.map(a => `'${a}'`).join(" ")}`;
  const tmuxCmd = [
    "new-session", "-d", "-s", session, "-c", cwd,
    `${piCmd} 2>&1 | tee ${path.join(statedir, "output.txt")}; echo '=== COMPLETED: $(date) ===' >> ${path.join(statedir, "output.txt")}`
  ];

  await execTmux(tmuxCmd);

  // Write state
  const state: SubagentState = {
    agentId,
    agentType,
    session,
    cwd,
    startTime: new Date().toISOString(),
    model: config?.model,
  };
  await fs.writeFile(
    path.join(statedir, "status.json"),
    JSON.stringify(state, null, 2)
  );

  // Return immediately (non-blocking), parent polls output.txt
  return { agentId, output: "", exitCode: 0 };
}

export async function listSubagents(): Promise<SubagentState[]> {
  // tmux list-sessions | grep pi-sub-
  // Parse and read status.json for each
}

export async function sendToSubagent(agentId: string, prompt: string): Promise<void> {
  const session = `pi-sub-${agentId}`;
  // Check if running, then:
  // tmux send-keys -t <session> C-c
  // tmux send-keys -t <session> "pi --no-interactive -p '<prompt>'" Enter
}

export async function getLogs(agentId: string, lines: number = 50): Promise<string> {
  const outputFile = path.join(STATEDIR, agentId, "output.txt");
  // tail -n <lines> outputFile
  // Also tmux capture-pane as fallback
}

export async function killSubagent(agentId: string): Promise<void> {
  const session = `pi-sub-${agentId}`;
  // Update status.json with end_time
  // tmux kill-session -t <session>
}

function execTmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", args, { stdio: "ignore" });
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`tmux exit ${code}`)));
  });
}
```

---

## Phase 4: State Management (`lib/state.ts`)

Track subagent metadata and enable persistence across Pi restarts.

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";

// State stored in ~/.local/share/pi-subagent/<agent-id>/
// - status.json: metadata (type, start time, model, etc.)
// - output.txt: captured stdout/stderr
// - progress.txt: optional incremental updates
```

---

## Phase 5: Custom Rendering (`lib/render.ts`)

Rich TUI display for subagent tool calls and results.

```typescript
import { Text, Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

export function renderSubagentCall(args: any, theme: any) {
  // Show "subagent spawn backend" with agent type highlighted
  // Show chain/parallel indicators
}

export function renderSubagentResult(result: any, options: any, theme: any) {
  // Multi-pane display:
  // - Header: Agent ID, type, status
  // - Body: Output or live preview
  // - Footer: Token usage, runtime
  // Support Ctrl+O expansion for full output
}
```

---

## Phase 6: Usage Patterns

LLM uses `subagent` tool directly instead of `/skill:` commands:

| Operation | Skill Approach | Extension Approach |
|-----------|---------------|-------------------|
| Spawn single | `/skill:tmux-subagent spawn backend "task"` | `subagent({mode:"spawn", agent:"backend", task:"..."})` |
| Spawn parallel | Multiple spawns | `subagent({mode:"spawn", tasks:[...]})` |
| Spawn chain | Manual coordination | `subagent({mode:"spawn", chain:[...]})` |
| List | `/skill:tmux-subagent list` | `subagent({mode:"list"})` |
| Send message | `/skill:tmux-subagent send <id> "..."` | `subagent({mode:"send", agentId:"...", prompt:"..."})` |
| View logs | `/skill:tmux-subagent logs <id>` | `subagent({mode:"logs", agentId:"..."})` |
| Kill | `/skill:tmux-subagent kill <id>` | `subagent({mode:"kill", agentId:"..."})` |

**Parallel example:**
```typescript
subagent({
  mode: "spawn",
  tasks: [
    { agent: "reviewer", task: "Review auth module" },
    { agent: "reviewer", task: "Review database layer" },
    { agent: "reviewer", task: "Review API endpoints" },
  ]
})
```

**Chain example:**
```typescript
subagent({
  mode: "spawn",
  chain: [
    { agent: "parser", task: "Parse CSV files" },
    { agent: "analyzer", task: "Analyze: {previous}" },
    { agent: "reporter", task: "Summarize findings from: {previous}" },
  ]
})
```

---

## Phase 7: Installation Commands

```bash
# 1. Create extension directory
mkdir -p ~/.pi/agent/extensions/tmux-subagent/lib

# 2. Write TypeScript files (index.ts, agents.ts, lib/*.ts)

# 3. Create agent configs
mkdir -p ~/.pi/agent/extensions/tmux-subagent/agents
# Create agents/backend.md, agents/reviewer.md, etc.

# 4. Pi auto-discovers extension on next start
# Or test immediately:
pi -e ~/.pi/agent/extensions/tmux-subagent/index.ts

# 5. Verify tool registration
pi --list-tools | grep subagent
```

---

## Key Differences: Skills vs Extensions

| Aspect | Skill Approach | Extension Approach |
|--------|---------------|-------------------|
| **Implementation** | Bash scripts Pi executes | TypeScript running in Pi process |
| **Invocation** | `/skill:tmux-subagent <cmd>` | `subagent({mode:"...", ...})` tool call |
| **Control flow** | Pi runs scripts, parses output | Extension manages directly, returns structured data |
| **Rendering** | Text output only | Custom TUI components, live updates |
| **State** | JSON files on disk | In-memory + persisted details |
| **Error handling** | Exit codes, text parsing | Typed exceptions, structured results |
| **Parallelism** | Multiple script invocations | `Promise.all()` with concurrency limits |
| **Chain mode** | Manual, external to Pi | Built-in with `{previous}` interpolation |
| **Hot reload** | Edit scripts, re-run | `/reload` updates extension |

---

## Deliverables Checklist

- [ ] `~/.pi/agent/extensions/tmux-subagent/index.ts` — main extension
- [ ] `agents.ts` — agent discovery with front-matter parsing
- [ ] `lib/tmux.ts` — tmux session management
- [ ] `lib/state.ts` — state file I/O
- [ ] `lib/render.ts` — TUI rendering for tool calls/results
- [ ] `agents/*.md` — example agent configurations
- [ ] `/subagents` command for listing active agents
- [ ] `subagent` tool with spawn/list/send/logs/kill modes
- [ ] Single, parallel, and chain spawn modes
- [ ] Agent ID system with unique IDs per instance
- [ ] Real-time output streaming via `onUpdate` callback

---

## Advantages Over Skill Approach

1. **Native integration**: Tool appears in Pi's tool list, no skill syntax to learn
2. **Structured results**: Details object contains full metadata, not just text
3. **Live updates**: `onUpdate` streams progress while subagents run
4. **Type safety**: Full TypeScript, no bash error handling
5. **Rich UI**: Custom rendering, expandable output, syntax highlighting
6. **Composability**: Chain/parallel modes built-in, not scripted externally
