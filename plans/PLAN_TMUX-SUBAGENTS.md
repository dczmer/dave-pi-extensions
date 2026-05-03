# Skill-Based Subagent Orchestration — Implementation Plan

## Overview

Create `tmux-subagent` skill Pi uses to spawn, manage, and coordinate subagents via tmux. No extensions, no SDK—pure skill instructions Pi executes with `bash` tool.

---

## Directory Structure

```
~/.pi/agent/skills/tmux-subagent/
├── SKILL.md
├── agents/
│   ├── backend.md
│   ├── frontend.md
│   └── reviewer.md
├── scripts/
│   ├── spawn.sh
│   ├── list.sh
│   ├── send.sh
│   ├── kill.sh
│   └── logs.sh
└── references/
    ├── architecture.md
    └── examples.md
```

**Note:** Agent instances are identified by unique agent IDs, not agent names. This allows multiple concurrent instances of the same agent type.

---

## Phase 1: Core SKILL.md

**File:** `~/.pi/agent/skills/tmux-subagent/SKILL.md`

```markdown
---
name: tmux-subagent
description: Spawn and manage Pi subagents in isolated tmux sessions for parallel task execution. Use when you need to delegate work to background agents, run multiple tasks concurrently, or coordinate a team of specialized agents.
---

# Tmux Subagent Orchestration

Manage Pi subagents running in isolated tmux sessions.

## Quick Start

Spawn your first subagent:
```bash
/skill:tmux-subagent spawn backend "Implement user authentication API"
# Returns: backend-a7f3k (unique agent ID)
```

Spawn with specialized agent configuration:
```bash
/skill:tmux-subagent spawn rust-expert "Review this code for safety issues"
# Returns: rust-expert-9x2m4 (unique agent ID)
```
(Requires `agents/rust-expert.md` file)

Spawn multiple instances of the same agent type:
```bash
/skill:tmux-subagent spawn reviewer "Review auth module"
# Returns: reviewer-k2p9n
/skill:tmux-subagent spawn reviewer "Review database layer"  
# Returns: reviewer-q5w8r (concurrent instance)
```

## Commands

### Spawn Subagent
```bash
./scripts/spawn.sh <agent-type> "<initial-task>" [cwd]
```
Creates detached tmux session with unique agent ID, running Pi with the task.

**Returns:** Unique agent ID (e.g., `rust-expert-a7f3k`) for referencing this specific instance.

**Agent Configuration Files:**
If `agents/${AGENT_TYPE}.md` exists, its content appends to the system prompt. Front-matter `model` attribute sets the model (e.g., `model: gpt-4o`).

The `<agent-type>` is the base name used to look up configuration. The returned agent ID uniquely identifies this specific instance.

Example agent file (`agents/backend.md`):
```markdown
---
model: claude-sonnet-4-20250514
---

You are a backend specialist. Focus on:
- API design patterns
- Database optimization
- Security best practices
- Error handling and logging
```

### List Active Subagents
```bash
./scripts/list.sh
```
Shows all agent instances with their unique IDs, agent types, status, and working directory.

Example output:
```
AGENT ID          TYPE       STATUS     START_TIME                CWD
rust-expert-a7f3  rust-expe  RUNNING    2024-01-15T10:30:00      /home/user/proj
reviewer-k2p9n    reviewer   RUNNING    2024-01-15T10:31:00      /home/user/proj
reviewer-q5w8r    reviewer   RUNNING    2024-01-15T10:32:00      /home/user/proj
```

### Send Command to Subagent
```bash
./scripts/send.sh <agent-id> "<prompt>"
```
Sends prompt to running subagent (identified by unique agent ID) via tmux key sequence.

Example:
```bash
./scripts/send.sh reviewer-k2p9n "Focus on SQL injection vulnerabilities"
```

### View Logs
```bash
./scripts/logs.sh <agent-id> [lines]
```
Tails subagent output (default 50 lines).

### Kill Subagent
```bash
./scripts/kill.sh <agent-id>
```
Terminates specific agent instance by its unique agent ID.

## Communication Patterns

Subagents write results to shared directory:
```
~/.local/share/pi-subagent/<name>/
├── output.txt      # Final result
├── progress.txt    # Incremental updates
└── status.json     # Metadata (pid, start_time, etc.)
```

Parent reads these files to collect results.

## Workflow Example

1. Spawn 3 subagents for parallel work (capture their unique IDs):
```bash
PARSER_ID=$(./scripts/spawn.sh parser "Parse CSV files in data/")
ANALYZER_ID=$(./scripts/spawn.sh analyzer "Analyze parsed results")
REPORTER_ID=$(./scripts/spawn.sh reporter "Generate summary report")
echo "Spawned: $PARSER_ID, $ANALYZER_ID, $REPORTER_ID"
```

2. Check status:
```bash
./scripts/list.sh
```

3. Send mid-course correction (using unique ID):
```bash
./scripts/send.sh "$PARSER_ID" "Also handle JSON files"
```

4. Spawn multiple reviewers working in parallel:
```bash
REVIEWER1=$(./scripts/spawn.sh reviewer "Review auth module")
REVIEWER2=$(./scripts/spawn.sh reviewer "Review database layer")
REVIEWER3=$(./scripts/spawn.sh reviewer "Review API endpoints")
```

5. Collect results when done:
```bash
cat ~/.local/share/pi-subagent/$PARSER_ID/output.txt
cat ~/.local/share/pi-subagent/$REVIEWER1/output.txt
```

## Best Practices

- Agent types should be descriptive (e.g., `backend`, `rust-expert`, `reviewer`)
- Capture the returned agent ID when spawning - you'll need it for all operations
- Keep initial tasks specific and bounded
- Check `./scripts/list.sh` to see active agents and their IDs
- Always `./scripts/kill.sh` finished subagents to free resources
- Multiple instances of the same agent type can run concurrently (e.g., 3 reviewers)

See [references/architecture.md](references/architecture.md) for protocol details.
```

---

## Phase 2: Helper Scripts

### `scripts/spawn.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_TYPE="${1:-}"
TASK="${2:-}"
CWD="${3:-$(pwd)}"

if [[ -z "$AGENT_TYPE" || -z "$TASK" ]]; then
    echo "Usage: spawn.sh <agent-type> '<task>' [cwd]"
    exit 1
fi

# Generate unique agent ID: <type>-<random>
RANDOM_SUFFIX=$(head /dev/urandom | tr -dc 'a-z0-9' | head -c 5)
AGENT_ID="${AGENT_TYPE}-${RANDOM_SUFFIX}"

SESSION="pi-sub-$AGENT_ID"
WORKDIR="$CWD"
STATEDIR="${HOME}/.local/share/pi-subagent/${AGENT_ID}"
SKILL_DIR="${HOME}/.pi/agent/skills/tmux-subagent"

# Create state directory
mkdir -p "$STATEDIR"

# Look for agent configuration file (by type, not ID)
AGENT_FILE="${SKILL_DIR}/agents/${AGENT_TYPE}.md"
SYSTEM_PROMPT_APPEND=""
MODEL_FLAG=""

if [[ -f "$AGENT_FILE" ]]; then
    echo "Loading agent configuration: $AGENT_FILE" >&2
    
    # Extract front-matter if present
    if head -1 "$AGENT_FILE" | grep -q '^---$'; then
        # Has front-matter, extract it
        FRONT_MATTER=$(sed -n '/^---$/,/^---$/p' "$AGENT_FILE" | sed '1d;$d')
        
        # Check for model attribute
        MODEL=$(echo "$FRONT_MATTER" | grep -E '^model:' | sed 's/^model:[[:space:]]*//' | tr -d '"' | tr -d "'")
        if [[ -n "$MODEL" ]]; then
            MODEL_FLAG="--model $MODEL"
            echo "Using model: $MODEL" >&2
        fi
        
        # Extract content after front-matter
        SYSTEM_PROMPT_APPEND=$(sed '1,/^---$/d' "$AGENT_FILE" | sed '1,/^---$/d')
    else
        # No front-matter, use entire file
        SYSTEM_PROMPT_APPEND=$(cat "$AGENT_FILE")
    fi
fi

# Build pi command
PI_CMD="pi --no-interactive"

if [[ -n "$MODEL_FLAG" ]]; then
    PI_CMD="$PI_CMD $MODEL_FLAG"
fi

if [[ -n "$SYSTEM_PROMPT_APPEND" ]]; then
    # Write agent prompt to file and use --system-prompt-file
    PROMPT_FILE="$STATEDIR/agent_prompt.txt"
    echo "$SYSTEM_PROMPT_APPEND" > "$PROMPT_FILE"
    PI_CMD="$PI_CMD --system-prompt-file '$PROMPT_FILE'"
fi

PI_CMD="$PI_CMD -p '$TASK'"

# Create detached tmux session with Pi running the task
tmux new-session -d -s "$SESSION" -c "$WORKDIR" \
    "echo '=== Subagent: $AGENT_ID ===' > '$STATEDIR/output.txt' && \
     echo 'Type: $AGENT_TYPE' >> '$STATEDIR/output.txt' && \
     echo 'Task: $TASK' >> '$STATEDIR/output.txt' && \
     $PI_CMD 2>&1 | tee -a '$STATEDIR/output.txt'; \
     echo '=== COMPLETED: $(date) ===' >> '$STATEDIR/output.txt'"

# Write metadata
STATUS_JSON="{
  \"agent_id\": \"$AGENT_ID\",
  \"agent_type\": \"$AGENT_TYPE\",
  \"session\": \"$SESSION\",
  \"cwd\": \"$WORKDIR\",
  \"start_time\": \"$(date -Iseconds)\""

if [[ -n "$MODEL_FLAG" ]]; then
    STATUS_JSON="$STATUS_JSON,
  \"model\": \"$MODEL\""
fi

if [[ -f "$AGENT_FILE" ]]; then
    STATUS_JSON="$STATUS_JSON,
  \"agent_file\": \"$AGENT_FILE\""
fi

STATUS_JSON="$STATUS_JSON,
  \"pid\": $(tmux list-panes -t "$SESSION" -F '#{pane_pid}' | head -1)
}"

echo "$STATUS_JSON" > "$STATEDIR/status.json"

# Output the agent ID (primary return value for scripts)
echo "$AGENT_ID"
```

### `scripts/list.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

printf "%-18s %-12s %-10s %-25s %s\n" "AGENT ID" "TYPE" "STATUS" "START_TIME" "CWD"
printf "%-18s %-12s %-10s %-25s %s\n" "==================" "============" "==========" "=========================" "=================="

tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^pi-sub-' | while read -r session; do
    agent_id="${session#pi-sub-}"
    statedir="${HOME}/.local/share/pi-subagent/${agent_id}"
    
    # Get agent type from status.json, fallback to parsing ID
    agent_type="$agent_id"
    if [[ -f "$statedir/status.json" ]]; then
        agent_type=$(grep -o '"agent_type": "[^"]*"' "$statedir/status.json" | cut -d'"' -f4 || echo "$agent_id")
    fi
    
    # Get working directory
    cwd=$(tmux display-message -t "$session" -p '#{pane_current_path}' 2>/dev/null || echo "unknown")
    
    # Check if process is still running
    if tmux list-panes -t "$session" -F '#{pane_dead}' | grep -q '0'; then
        status="RUNNING"
    else
        status="COMPLETED"
    fi
    
    # Get start time if available
    start_time="unknown"
    if [[ -f "$statedir/status.json" ]]; then
        start_time=$(grep -o '"start_time": "[^"]*"' "$statedir/status.json" | cut -d'"' -f4 || echo "unknown")
    fi
    
    # Truncate long values for display
    agent_type_short="${agent_type:0:12}"
    cwd_short="${cwd:0:30}"
    
    printf "%-18s %-12s %-10s %-25s %s\n" "$agent_id" "$agent_type_short" "$status" "$start_time" "$cwd_short"
done

echo ""
echo "State directory: ~/.local/share/pi-subagent/"
```

### `scripts/send.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="${1:-}"
PROMPT="${2:-}"

if [[ -z "$AGENT_ID" || -z "$PROMPT" ]]; then
    echo "Usage: send.sh <agent-id> '<prompt>'"
    exit 1
fi

SESSION="pi-sub-$AGENT_ID"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Error: Session $SESSION not found"
    exit 1
fi

# Check if Pi is still running in the session
if tmux list-panes -t "$SESSION" -F '#{pane_dead}' | grep -q '1'; then
    echo "Warning: Subagent $AGENT_ID has exited. Starting new Pi instance..."
    tmux respawn-window -t "$SESSION" -k "pi --no-interactive -p '$PROMPT'"
else
    # Send Ctrl+C to interrupt current work, then new prompt
    tmux send-keys -t "$SESSION" C-c
    sleep 0.5
    tmux send-keys -t "$SESSION" "pi --no-interactive -p '$PROMPT'" Enter
fi

echo "Sent prompt to subagent '$AGENT_ID'"
```

### `scripts/logs.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="${1:-}"
LINES="${2:-50}"

if [[ -z "$AGENT_ID" ]]; then
    echo "Usage: logs.sh <agent-id> [lines]"
    exit 1
fi

SESSION="pi-sub-$AGENT_ID"
STATEDIR="${HOME}/.local/share/pi-subagent/${AGENT_ID}"
OUTPUT_FILE="$STATEDIR/output.txt"

if [[ -f "$OUTPUT_FILE" ]]; then
    echo "=== Output file ($OUTPUT_FILE) ==="
    tail -n "$LINES" "$OUTPUT_FILE"
else
    echo "No output file found at $OUTPUT_FILE"
fi

echo ""
echo "=== Tmux capture ==="
if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION" -p | tail -n "$LINES"
else
    echo "Session $SESSION not found"
fi
```

### `scripts/kill.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="${1:-}"

if [[ -z "$AGENT_ID" ]]; then
    echo "Usage: kill.sh <agent-id>"
    exit 1
fi

SESSION="pi-sub-$AGENT_ID"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session $SESSION not found"
    exit 1
fi

# Write completion status
STATEDIR="${HOME}/.local/share/pi-subagent/${AGENT_ID}"
if [[ -f "$STATEDIR/status.json" ]]; then
    # Update JSON with end time
    tmp=$(mktemp)
    jq '. + {"end_time": "'$(date -Iseconds)'", "killed_by_user": true}' \
        "$STATEDIR/status.json" > "$tmp" && mv "$tmp" "$STATEDIR/status.json"
fi

tmux kill-session -t "$SESSION"
echo "Killed subagent '$AGENT_ID' (session: $SESSION)"
```

---

## Phase 3: Agent Configuration Files

Create specialized agents in `agents/` directory. Files named `${NAME}.md` auto-load when spawning subagent with matching name.

### Example: `agents/rust-expert.md`

```markdown
---
model: claude-sonnet-4-20250514
---

You are a Rust language expert specializing in:
- Memory safety and ownership patterns
- Async/await and concurrency
- Unsafe code review
- Performance optimization
- Idiomatic Rust patterns

When reviewing code:
1. Identify potential safety issues first
2. Suggest more idiomatic alternatives
3. Explain trade-offs clearly
```

### Front-matter Attributes

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `model` | Override default model | `model: gpt-4o` |

Content after front-matter appends to system prompt.

---

## Phase 5: Reference Documentation

### `references/architecture.md`

```markdown
# Subagent Architecture

## Agent Identity System

Each subagent instance receives a unique **Agent ID**:
- Format: `<agent-type>-<random>` (e.g., `rust-expert-a7f3k`)
- Generated at spawn time using 5-char random suffix
- All operations reference agents by their unique Agent ID
- Multiple instances of same agent type can run concurrently

Benefits:
- No naming collisions when running parallel instances
- Caller controls lifecycle of each specific instance
- Easy to track and manage concurrent workers

## Session Naming

All subagent tmux sessions prefixed with `pi-sub-<agent-id>`:
- Session: `pi-sub-rust-expert-a7f3k`
- Avoids conflicts with user tmux sessions
- Enables discovery via `tmux list-sessions | grep pi-sub-`

## State Management

State stored in `~/.local/share/pi-subagent/<agent-id>/`:
- `status.json`: Metadata including agent_type, agent_id, model, timing, PID
- `output.txt`: Captured stdout/stderr
- `progress.txt`: Optional incremental updates
- `agent_prompt.txt`: Extracted system prompt from agent config file

## Communication Protocol

Subagents are stateless from parent perspective. Parent:
1. Spawns with agent type and initial task via spawn.sh
2. Receives unique Agent ID as return value
3. Polls output.txt for results using Agent ID
4. Sends mid-course corrections via send.sh using Agent ID
5. Cleans up via kill.sh using Agent ID

No direct IPC—filesystem-based coordination.

## Agent Configuration System

Agent files in `agents/<agent-type>.md` provide:
1. **Model selection**: Override default model via front-matter
2. **System prompt extension**: Append specialized instructions
3. **Type-based loading**: All instances of same type share config

Loading precedence:
1. Spawn command receives agent type (e.g., `spawn rust-expert ...`)
2. Script generates unique Agent ID: `rust-expert-a7f3k`
3. Script checks for `agents/rust-expert.md`
4. If found: parse front-matter, extract model, append content to system prompt
5. If not found: use default Pi configuration

## Security Considerations

- Subagents inherit parent's environment
- Subagents run with same permissions as parent Pi
- Each subagent isolated in own tmux session
- Working directory set at spawn time, can be restricted
```

---

## Phase 6: Installation Commands

```bash
# 1. Create skill directory
mkdir -p ~/.pi/agent/skills/tmux-subagent/scripts
mkdir -p ~/.pi/agent/skills/tmux-subagent/agents
mkdir -p ~/.pi/agent/skills/tmux-subagent/references

# 2. Write SKILL.md (copy content from Phase 1 above)
# Use editor or cat heredoc

# 3. Write scripts (copy content from Phase 2 above)
# Create each file in scripts/

# 4. Create example agent configs in agents/
# Create agents/rust-expert.md, agents/reviewer.md, etc.

# 5. Make scripts executable
chmod +x ~/.pi/agent/skills/tmux-subagent/scripts/*.sh

# 6. Verify installation
pi --list-skills | grep tmux-subagent

# 7. Test - capture and use Agent ID
AGENT_ID=$(/skill:tmux-subagent spawn test "echo Hello from subagent")
echo "Spawned agent: $AGENT_ID"
/skill:tmux-subagent logs "$AGENT_ID"
/skill:tmux-subagent kill "$AGENT_ID"

# 8. Test concurrent instances
ID1=$(/skill:tmux-subagent spawn reviewer "Review file A")
ID2=$(/skill:tmux-subagent spawn reviewer "Review file B")
echo "Concurrent reviewers: $ID1, $ID2"
/skill:tmux-subagent list
```

---

## Phase 7: Usage Workflow

```bash
# In Pi, use skill commands:
# Spawn returns unique agent ID
/skill:tmux-subagent spawn api "Design REST API for user management"
# Returns: api-x7k2m

# Use the agent ID for subsequent operations
/skill:tmux-subagent send api-x7k2m "Add pagination to the endpoints"
/skill:tmux-subagent logs api-x7k2m
/skill:tmux-subagent kill api-x7k2m

# Spawn multiple instances of same type
/skill:tmux-subagent spawn reviewer "Review auth module"
# Returns: reviewer-a1b2c
/skill:tmux-subagent spawn reviewer "Review database layer"
# Returns: reviewer-d3e4f

# Or invoke via natural language:
"Spawn a subagent of type 'refactor' to clean up the utils folder"
```

Pi will:
1. Match description to `tmux-subagent` skill
2. Load SKILL.md instructions
3. Execute appropriate script via bash tool
4. Capture and return the unique Agent ID
5. Use Agent ID to read results from output files

---

## Deliverables Checklist

- [ ] `~/.pi/agent/skills/tmux-subagent/SKILL.md` with frontmatter + instructions (updated for Agent IDs)
- [ ] `agents/` directory created with example files
- [ ] `agents/rust-expert.md` — example specialized agent config
- [ ] `scripts/spawn.sh` — generate unique Agent ID, create tmux session, load agent configs, return Agent ID
- [ ] `scripts/list.sh` — display Agent IDs with types and status
- [ ] `scripts/send.sh` — accept Agent ID as parameter
- [ ] `scripts/logs.sh` — accept Agent ID as parameter
- [ ] `scripts/kill.sh` — accept Agent ID as parameter
- [ ] `references/architecture.md` — document Agent ID system
- [ ] All scripts made executable (`chmod +x`)
- [ ] Test: Spawn agent and capture returned Agent ID
- [ ] Test: Spawn multiple instances of same agent type concurrently
- [ ] Test: Send commands to specific Agent ID
- [ ] Test: List shows unique Agent IDs for concurrent instances

---

## Notes

- Requires tmux 3.2+ for best compatibility
- Subagents run `pi --no-interactive` — no TUI, headless mode
- **Agent ID System**: Each spawn generates unique ID (`<type>-<random>`) enabling multiple concurrent instances
- Pi-specific flags used:
  - `--model <name>` — override default model
  - `--system-prompt-file <path>` — append agent-specific instructions
- State persists in `~/.local/share/pi-subagent/` across restarts (indexed by Agent ID)
- Parent Pi monitors via file polling, not real-time IPC
- Agent files use YAML front-matter for metadata, markdown content for instructions
