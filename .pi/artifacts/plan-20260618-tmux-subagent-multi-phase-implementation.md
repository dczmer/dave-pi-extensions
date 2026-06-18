# Multi-phase implementation plan: tmux-backed observable subagents

This plan decomposes the tmux-backed subagent extension into small, testable,
reviewable phases. It follows the tighter split option so each phase changes
only one major concern.

Each phase has:

- **Goal** — what it produces.
- **Scope** — exactly what is in and out.
- **Tasks** — concrete work items.
- **Tests** — how to verify it in isolation.
- **Acceptance** — when this phase is done.
- **Why a discrete slice** — why it can stand alone.

---

## Phase 0 — Scaffolding and agent discovery

### Goal

A loadable directory extension that pi discovers and that can parse agent
definitions from `agents/*.md` files.

### Scope

- Create `extensions/tmux-subagent/`.
- Add skeleton `index.ts`, `agents.ts`, and `tmux.ts`.
- Copy `agents/*.md` and `prompts/*.md` from `examples/extensions/subagent/`.
- Port `discoverAgents`, frontmatter parsing, and agent type definitions from the
  example.
- Fix imports to use `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`.
- Register a minimal tool named `subagent` that returns a placeholder
  `AgentToolResult`.

### Tasks

1. Create directory layout.
2. Implement `agents.ts` with `AgentConfig`, `AgentScope`, and `discoverAgents`.
3. Implement `index.ts` shell: `registerTool('subagent')`, parse arguments,
   return placeholder result.
4. Add shared type aliases and constants.
5. Copy sample agent/prompt markdown files.

### Tests

- `test/extensions/tmux-subagent/agents.test.ts` parses sample agents.
- `test/extensions/tmux-subagent/index.test.ts` asserts tool name and that the
  extension registers without throwing.
- `npm test` passes; `npm run typecheck` passes.

### Acceptance

- `pi` loads `subagent`.
- Agent discovery returns expected agents from sample files.
- Placeholder call returns a non-error result.

### Why a discrete slice

No tmux, no child process, no filesystem workspace. It validates the extension
packaging and agent model in isolation.

---

## Phase 1 — Tmux shell primitives

### Goal

A small, testable module that knows how to ask tmux for availability, create a
new window, and kill windows.

### Scope

- Implement `tmux.ts`:
  - `isTmuxAvailable()`
  - `isInsideTmux(env?)`
  - `runInWindow(opts)` returning the `@<id>` window id
  - `killWindow(windowId)`
  - `killAllWindows()`
  - `capturePane(windowId)` (optional diagnostic)
- Maintain an in-flight window set at module level.
- No integration with agent logic yet.

### Tasks

1. Implement availability checks.
2. Implement `runInWindow` using `tmux new-window -d -n <label> -c <cwd> -P -F
   "#{window_id}" -- bash <launcherPath>`.
3. Implement kill helpers with `execFileSync` / `spawnSync`.
4. Sanitize and truncate window labels to `[^a-zA-Z0-9_-]`.
5. Keep `Set<string>` of in-flight ids; add on create, remove on kill.

### Tests

- `test/extensions/tmux-subagent/tmux.test.ts`:
  - `isTmuxAvailable` true/false based on mocked `tmux -V`.
  - `isInsideTmux` respects optional `env`.
  - `runInWindow` parses `@[0-9]+` id from stdout.
  - `killWindow` issues correct `tmux kill-window -t @id`.
  - `killAllWindows` kills every id in the set.
  - Missing tmux or not inside tmux returns clear errors, does not throw into
    tool caller.

### Acceptance

- All `tmux.ts` functions have unit tests.
- Module can create and kill windows deterministically through mocks.

### Why a discrete slice

Tmux is the only new external dependency. Wrapping it in a dedicated module lets
us test the subprocess contract without bringing in event parsing or workspace
management.

---

## Phase 2 — Workspace and launcher

### Goal

Create the per-session and per-task directories, write `prompt.md` and
`launcher.sh`, and build the resolved `pi` invocation string.

### Scope

- Lazy session temp root under `/tmp/pi-tmux-sub/<session-id>/`.
- Per-task directory allocation with collision retry.
- Write `prompt.md` (mode `0o600`) and `launcher.sh` (mode `0o600`).
- Build pi invocation:
  `--mode json -p --no-session --no-plan [--model M] [--tools ...]
  --append-system-prompt prompt.md "Task: ..."`.
- Launcher script `cd`s to cwd, runs invocation, redirects stdout to
  `events.jsonl`, stderr to `stderr.log`, then writes exit code to
  `exit.marker`.
- No polling yet; just produce artifacts.

### Tasks

1. Implement `ensureSessionTempRoot(sessionId)`.
2. Implement `allocateTaskDir(sessionTempRoot, safeAgentName, index)` with
   `EEXIST` retry.
3. Map mode to starting index: `single` → 0, `chain` → 1-based step, `parallel`
   → array index.
4. Write `prompt.md` using `withFileMutationQueue`.
5. Build `launcher.sh` with absolute paths.
6. Implement `getPiInvocation` helper reused from example.

### Per-task directory allocation strategy

Each subagent task needs a stable, unique workspace directory inside the
session temp root. Collision can happen when:

- The same agent is invoked twice in one session (e.g., two `single` calls).
- A chain or parallel task uses an index that overlaps with a previous run.
- A stale directory from an earlier session was not cleaned up.

To avoid collision we use **atomic directory creation with deterministic names
plus a numeric suffix retry**.

#### Directory name format

```
<session-temp-root>/<safe-agent-name>-<index>[-<suffix>]/
```

- `safe-agent-name` — agent name reduced to `[a-zA-Z0-9_-]` and truncated to
  32 chars.
- `index` — the mode-dependent starting index (`single` = 0, chain step =
  1-based, parallel = array index).
- `suffix` — appended only when the base name already exists; starts at 1 and
  increments until `mkdir` succeeds.

Examples:

```
/tmp/pi-tmux-sub/sess-abc123/coder-0/
/tmp/pi-tmux-sub/sess-abc123/coder-0-1/   # second single call with same agent
/tmp/pi-tmux-sub/sess-abc123/reviewer-1/  # chain step 1
/tmp/pi-tmux-sub/sess-abc123/worker-2/    # parallel task index 2
```

#### Allocation algorithm

```ts
function allocateTaskDir(
  sessionTempRoot: string,
  agentName: string,
  index: number,
): string {
  const safe = sanitize(agentName);
  const baseName = `${safe}-${index}`;
  const basePath = join(sessionTempRoot, baseName);

  try {
    mkdirSync(basePath, { mode: 0o700 });
    return basePath;
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }

  for (let suffix = 1; suffix < 1000; suffix++) {
    const candidate = `${basePath}-${suffix}`;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  throw new Error(`could not allocate task dir for ${baseName}`);
}
```

- `mkdirSync` without `recursive: true` is atomic on POSIX; if it succeeds the
caller owns the directory.
- `EEXIST` is the only expected failure. Everything else propagates.
- A hard suffix ceiling (e.g., 999) prevents infinite loops under pathological
conditions.

#### Why not UUIDs

UUIDs would guarantee uniqueness, but deterministic names make debugging,
testing, and log correlation easier. The suffix retry keeps names readable
while still handling overlap.

#### Mode-to-index mapping

| Mode      | Index source                                  | Example dirs          |
| --------- | --------------------------------------------- | --------------------- |
| `single`  | always 0                                      | `coder-0`             |
| `chain`   | 1-based step number                           | `coder-1`, `coder-2`  |
| `parallel`| array index (0-based)                         | `worker-0`, `worker-1`|

Using different index spaces per mode is fine because overlap is resolved by
the suffix retry; the starting index only reflects the logical position of the
task in the invocation.

#### Files written into the task dir

Once allocated, the task dir receives:

- `prompt.md` — the rendered system prompt for this task (mode `0o600`).
- `launcher.sh` — bash script that `cd`s to the user's cwd, runs the resolved
  `pi` invocation, redirects stdout to `events.jsonl`, stderr to
  `stderr.log`, and writes the exit code to `exit.marker` (mode `0o700`).
- `events.jsonl`, `stderr.log`, `exit.marker` — produced by the launcher at
  runtime.

All writes use absolute paths so the launcher can be executed from any tmux
window working directory.

### Tests

- `test/extensions/tmux-subagent/workspace.test.ts`:
  - `ensureSessionTempRoot` creates directory under `/tmp/pi-tmux-sub/`.
  - `allocateTaskDir` returns `agent-0` on first call.
  - `allocateTaskDir` returns `agent-0-1` when `agent-0` already exists.
  - `allocateTaskDir` returns `agent-0-2` when `agent-0` and `agent-0-1` exist.
  - `allocateTaskDir` retries collisions deterministically for each mode
    (`single`, `chain`, `parallel`).
  - `allocateTaskDir` throws after exhausting the suffix ceiling.
  - `launcher.sh` contains absolute paths and correct redirections.
  - Invocation includes `--no-plan` and `--append-system-prompt`.
- All tests use `withTempDir`.

### Acceptance

- Given an agent name and task, the phase can create a directory and launcher
  that look correct on disk.
- Collision retry works deterministically.

### Why a discrete slice

Filesystem setup and command-line construction are independent from tmux window
management and from event parsing. This phase produces inspectable artifacts
that can be verified by reading files.

---

## Phase 3a — Single-agent synchronous runner

### Goal

Run one subagent in a tmux window and return the final result after the process
exits, without streaming updates.

### Scope

- Combine Phase 1 and Phase 2 to create a window from a launcher.
- Wait for `exit.marker` to appear (polling loop at ~250 ms).
- After exit, read `events.jsonl` from start to end, parse each line with the
  existing `processLine` logic from the example, and build `Message[]` / usage.
- Read `stderr.log`.
- Kill the window.
- Return an `AgentToolResult`.
- No `onUpdate` streaming yet.

### Tasks

1. Implement `runSingleAgentSync` in `index.ts`.
2. Reuse example's `processLine`, `getFinalOutput`, `formatUsageStats`, etc.
3. Handle non-zero exit codes as failed results.
4. Surface stderr in the result.

### Tests

- `test/extensions/tmux-subagent/runner-sync.test.ts`:
  - Mock `tmux.ts` and child-process files.
  - Provide fixture `events.jsonl` and `exit.marker` files.
  - Assert final content, usage, and stderr are assembled correctly.
  - Assert window is killed after exit.

### Acceptance

- A single task produces a correct final result from static fixture files.
- Window lifecycle is invoked exactly once per task.

### Why a discrete slice

This is the first end-to-end path, but it intentionally skips streaming. The
simpler "wait then read" loop is easier to test and gets final-result plumbing
right before adding incremental updates.

---

## Phase 3b — Incremental poll loop and streaming updates

### Goal

Replace the synchronous read with an incremental poll loop that feeds
`onUpdate` as events arrive.

### Scope

- Track byte offset into `events.jsonl`.
- On each tick, read only new bytes and append to a line buffer.
- Emit each complete parsed event through `onUpdate`.
- When `exit.marker` appears, do one final read, capture exit code, then kill
  window.
- Tolerate `events.jsonl` not existing yet on the first tick.

### Tasks

1. Implement incremental read with `fs.openSync`/`fs.readSync` or
  `fs.createReadStream({ start: offset })`.
2. Buffer partial lines across ticks.
3. Wire `onUpdate` to emit `Message` updates.
4. Keep accumulated state for final result assembly.

### Tests

- `test/extensions/tmux-subagent/runner-streaming.test.ts`:
  - Fixture `events.jsonl` is written in chunks across ticks.
  - Assert `onUpdate` is called the expected number of times.
  - Assert final result matches full event stream.
  - Test missing-file-at-start behavior.

### Acceptance

- Streaming results appear before the subagent exits.
- Final result is identical to the synchronous version.

### Why a discrete slice

Streaming is a user-facing feature, but its logic (incremental file reading and
update emission) is orthogonal to multi-agent orchestration. Perfecting it for
one task avoids debugging concurrency at the same time.

---

## Phase 4a — Parallel mode

### Goal

Run up to 4 subagents concurrently and aggregate their results.

### Scope

- Implement `parallel` mode in the tool handler.
- Use `mapWithConcurrencyLimit` (concurrency = 4) over the task array.
- Each task gets its own window and workspace dir with the array index.
- Aggregate individual `AgentToolResult`s.
- Apply `truncateParallelOutput` and `renderResult`.
- Stop gathering new results on first failure? Decision: continue and let
  `renderResult` summarize; do not short-circuit unless specified.

### Tasks

1. Add parallel argument parsing.
2. Implement concurrent runner with throttling.
3. Aggregate outputs and usage.
4. Format final parallel result.

### Tests

- `test/extensions/tmux-subagent/parallel.test.ts`:
  - Mock tmux and filesystem.
  - Verify exactly 4 windows are in flight at peak for 8 tasks.
  - Verify aggregate result contains outputs from all tasks.
  - Verify each task dir uses correct index.

### Acceptance

- Parallel tasks create multiple tmux windows.
- Concurrency does not exceed 4.
- Final result is rendered correctly.

### Why a discrete slice

Parallelism is just N independent single-agent runs plus aggregation. Once
Phase 3b works, this phase adds only scheduling and formatting.

---

## Phase 4b — Chain mode

### Goal

Run subagents sequentially, substituting the previous result into the next
task's prompt, and stop on first failure.

### Scope

- Implement `chain` mode in the tool handler.
- Replace `{previous}` placeholder in each step's task with the rendered output
  of the prior step.
- Use 1-based step number for task directory index.
- Stop at first failed result and return the failure.
- Render final chain result.

### Tasks

1. Add chain argument parsing.
2. Implement sequential loop with `{previous}` substitution.
3. Track previous output across steps.
4. Short-circuit on failure.

### Tests

- `test/extensions/tmux-subagent/chain.test.ts`:
  - Mock tmux and filesystem.
  - Verify sequential creation order.
  - Verify `{previous}` substitution uses prior result output.
  - Verify failure stops the chain and returns the failing step.
  - Verify step numbers map to directory indices (`agent-1`, `agent-2`, ...).

### Acceptance

- Chain runs one window at a time.
- Previous output flows into next prompt.
- Failure halts the chain.

### Why a discrete slice

Chain mode is the dual of parallel mode: scheduling becomes sequential and adds
a data dependency between steps. Keeping it separate avoids mixing concurrency
bugs with substitution logic.

---

## Phase 5 — Lifecycle, cleanup, and abort

### Goal

Handle abort signals, session shutdown, session restart, and explicit garbage
collection.

### Scope

- **Abort**: on `signal.aborted`, set `wasAborted = true`, kill the window, and
  throw/report aborted.
- **`session_shutdown`**: kill all in-flight windows, remove
  `sessionTempRoot`, reset module state.
- **`session_start` with `reason === 'new'`**: remove previous
  `sessionTempRoot` before creating a new one.
- **`/tmux-subagent-gc` command**: immediately remove current `sessionTempRoot`;
  skip active task dirs if windows are still in flight, otherwise remove the
  entire root.
- Never call `tmux kill-session`.

### Tasks

1. Wire abort handling into poll loop.
2. Implement shutdown handler using extension lifecycle events.
3. Implement new-session cleanup.
4. Implement `/tmux-subagent-gc` command.
5. Reset module-level `sessionTempRoot` and in-flight set appropriately.

### Tests

- `test/extensions/tmux-subagent/lifecycle.test.ts`:
  - Abort signal kills in-flight window and reports aborted.
  - Shutdown kills in-flight windows and removes temp root.
  - New session start removes old root before allocating new one.
  - GC command removes root when idle and skips active dirs when busy.

### Acceptance

- No tmux windows leak after shutdown.
- No temp directories leak across explicit new sessions.
- Abort is responsive and surfaces correctly.

### Why a discrete slice

Resource cleanup is cross-cutting but can be implemented after the core runner
is stable. It touches only tmux lifecycle, filesystem cleanup, and signal
handling.

---

## Phase 6 — Integration verification and documentation

### Goal

Prove the extension works inside a real tmux session and is documented.

### Scope

- Run all automated checks.
- Manual scenarios inside tmux.
- Add or update README if the extension becomes user-facing.

### Automated checks

1. `npm test`
2. `npm run typecheck`
3. `npx eslint .`
4. `npm run format:check`
5. `mdl README.md docs/**/*.md` if any docs changed.

### Manual scenarios

1. Outside tmux or with tmux missing: tool returns `isError: true` result, no
   fallback.
2. Single agent: window appears, streaming updates work, final result returned,
   window killed.
3. Parallel: up to 4 concurrent windows, aggregate result, all windows killed.
4. Chain: sequential windows, `{previous}` substitution, stops on first failure.
5. Abort: Ctrl+C kills window and reports aborted.
6. Quit pi mid-run: `session_shutdown` kills in-flight windows; user tmux
   session survives.
7. Project agents: confirmation gate fires for project-scoped agents.

### Documentation tasks

1. Add `extensions/tmux-subagent/README.md` describing the tool, modes, and
   cleanup behavior.
2. Document that windows are killed on completion.
3. Document the `/tmux-subagent-gc` command.

### Acceptance

- All automated checks pass.
- Manual scenarios pass inside a real tmux session.
- Docs are linted and accurate.

### Why a discrete slice

This phase is purely validation and communication. It does not add behavior,
but it is the gate that confirms all prior slices compose correctly.

---

## Dependency graph

```
Phase 0 (scaffolding)
    │
    ▼
Phase 1 (tmux primitives)
    │
    ▼
Phase 2 (workspace + launcher)
    │
    ▼
Phase 3a (single-agent sync)
    │
    ▼
Phase 3b (streaming poll loop)
    │
    ├──► Phase 4a (parallel)
    │
    └──► Phase 4b (chain)
              │
              ▼
        Phase 5 (lifecycle + cleanup)
              │
              ▼
        Phase 6 (integration + docs)
```

Each arrow means "depends on" but not necessarily "blocks merge". Phases can be
merged into `main` as they pass their own acceptance tests.

---

## Notes

- Keep no `package.json` inside `extensions/tmux-subagent/`.
- Use project root dependencies only.
- Follow repo style: single quotes, Prettier formatting, JSDoc on exported
  functions and interfaces.
- All tests must use temp directories and mocked `node:child_process`; never
  mutate real user config or `process.env`.
