# Implementation plan: tmux-based subagents for pi coding agent

Build a pi extension that delegates tasks to subagents running as observable `pi` processes inside dedicated tmux windows, instead of hidden child processes.

## Context

Pi ships no built-in subagents by design. Philosophy doc says: *"Spawn pi instances via tmux. Full observability, direct interaction."*

Existing example `examples/extensions/subagent/` already delegates to child `pi` processes, but it spawns them **hidden** via `node:child_process.spawn` with piped stdio in `--mode json`. No observability — user cannot watch, attach, or interact while the subagent runs. Process dies if parent dies.

tmux variant adds:
- **Observability**: each subagent runs in its own tmux window; user attaches to watch live.
- **Persistence**: subagent survives parent pi crash/exit (lives in tmux server).
- **Direct interaction**: user can jump into a stuck subagent's pane.
- **Same structured results**: parent still parses JSONL events to produce streaming updates + final output in the tool result.

Environment confirmed: `tmux 3.5a` at `/opt/homebrew/bin/tmux`.

## Recommended approach

Reuse the proven JSON-event parsing and rendering from the existing `subagent` example, but change the **execution backend** from `spawn(...)` with stdio pipes to:

1. Write the subagent's full command to a launcher shell script in a temp dir (avoids tmux quoting hell).
2. Launch it in a new tmux window **in the user's current tmux session** (pi runs inside tmux).
3. The launcher runs `pi --mode json -p --no-session ...` redirecting JSONL to an events file, captures exit code to a marker file, then keeps the window alive for inspection.
4. Parent extension **tails the events file** (byte-offset incremental read, ~250 ms poll) running the *same* `processLine` parser as the existing example to emit `onUpdate` streaming and collect the final `Message[]`.
5. Completion detected by presence of the exit-code marker file.
6. On completion (after final read) → parent runs `tmux kill-window` for that subagent's window. The subagent's window goes away when its process is done; the user's own session/windows are untouched.
7. Abort (Ctrl+C / `signal`) → `tmux kill-window`.
8. `session_shutdown` → **NEVER `kill-session`**. Kill any still-running tracked subagent windows + temp cleanup only.

**Lifecycle rule (changed):** pi runs *inside* the user's tmux session. Subagent windows are created in that current session so they're immediately observable as adjacent windows. Therefore the extension must **never** `tmux kill-session` — that would destroy the user's whole session and everything in it, not just subagents. Cleanup is strictly **per-window**: kill each subagent window when its process completes (or on abort), and on shutdown kill only the windows this parent still has in flight.

Why JSON mode in the pane (vs. interactive/print):
- JSON mode streams **every** event (tool calls, messages) → parent gets rich structured streaming identical to existing example, and the pane visibly scrolls (observably "working").
- Interactive mode needs scraping the TUI to extract results (fragile). Print mode (`-p` alone) only emits final text → empty pane during the run (poor observability) and no tool-call stream.
- Tradeoff: raw JSON in the pane is less pretty for humans. Acceptable — observability for the *human* comes primarily from a dedicated `/attach` flow and the structured parent render. Optionally pipe through `jq -c .` if `jq` present (detect, fallback to raw).

This keeps ~90% of the existing example reusable; only the runner and a tmux helper module are new.

## Architecture diagram

```
parent pi (TUI, running inside user's tmux session $TMUX)
  └─ extension: tmux-subagent
       │  registerTool("tmux_subagent")  modes: single | parallel | chain
       │  registerCommand("attach")      switch to a live subagent window
       │  on(session_shutdown)           kill leftover subagent WINDOWS + cleanup tmpdir
       │                                 (NEVER kill-session)
       │
       ▼  per task:
   write launcher.sh + prompt.md to  /tmp/pi-tmux-sub-<pid>/<taskid>/
       │
       ▼
   tmux new-window -n <label> -c <cwd> -P -F "#{window_id}" -- bash launcher.sh
       │   (new window in the CURRENT session; track returned @window_id)
       │                                   │
       │                                   ▼
       │                          pi --mode json -p --no-session \
       │                            [--model M] [--tools ...] \
       │                            --append-system-prompt prompt.md "Task: ..." \
       │                            > events.jsonl 2> stderr.log
       │                          echo $? > exit.marker   (then process exits)
       │
       ▼  poll loop (250ms)
   read new bytes of events.jsonl ──► processLine() ──► onUpdate(stream)
   check exit.marker exists       ──► final read, read exit code
                                  ──► tmux kill-window -t @id   ◄── kill on completion
                                  ──► untrack window, return result
       │
       ▼ on abort
   tmux kill-window -t @id
```

```
user's tmux session  (created/owned by the user — extension never kills it)
 ├─ window: pi           ← the parent pi TUI (the user)
 ├─ window: scout-1      ← live JSONL stream; killed when its process completes
 ├─ window: planner-2    ← killed on completion
 └─ window: worker-3     ← killed on completion / abort
```

## File layout (new extension)

This is a **pi extension repository**. Place the extension under `./extensions` (auto-discovered via `package.json` `pi.extensions`), **not** `~/.pi/agent/extensions/`.

`extensions/tmux-subagent/`
- `index.ts`  — tool + command registration, modes, render (adapted from example `index.ts`).
- `agents.ts` — **reuse** from `examples/extensions/subagent/agents.ts` (agent discovery, frontmatter parse, scope); adapt imports.
- `tmux.ts`   — **new** tmux orchestration helper (see below).
- `agents/*.md`, `prompts/*.md` — reuse sample agents/prompts from the example.

Tests (mirror path, per repo convention — outside `extensions/` so pi never treats them as extensions):
- `test/extensions/tmux-subagent/tmux.test.ts` — unit-test the tmux helper (argv construction, launcher script content, window-id parsing, kill-window/never-kill-session). Mock `spawnSync`/`execFileSync` with `t.mock.method`; use tempfs (`mkdtempSync`) for any file writes per AGENTS.md test-isolation rules.
- `test/extensions/tmux-subagent/index.test.ts` — poll-loop / `processLine` parsing against fixture `events.jsonl`; completion + kill-window-on-complete; abort path.

**Import scope adaptation (required):** the example uses `@earendil-works/*`; this repo/runtime uses `@mariozechner/*`. Map every import:
- `@earendil-works/pi-agent-core` → `@mariozechner/pi-agent-core` (`AgentToolResult`)
- `@earendil-works/pi-ai` → `@mariozechner/pi-ai` (`Message`, `StringEnum`)
- `@earendil-works/pi-coding-agent` → `@mariozechner/pi-coding-agent` (`ExtensionAPI`, `getMarkdownTheme`, `withFileMutationQueue`)
- `@earendil-works/pi-tui` → `@mariozechner/pi-tui` (`Container`, `Markdown`, `Spacer`, `Text`)
- `typebox` → `typebox` (available in runtime node_modules; confirm resolvable from repo)

No `package.json` inside the extension dir — uses project-root deps (AGENTS.md). Sub-modules imported with relative `.ts` paths.

Source references to copy/adapt:
- `examples/extensions/subagent/index.ts` — parsing (`processLine` logic in `runSingleAgent`), `formatUsageStats`, `formatToolCall`, `getDisplayItems`, `getFinalOutput`, `isFailedResult`, `truncateParallelOutput`, `mapWithConcurrencyLimit`, `renderCall`, `renderResult`, param schemas.
- `examples/extensions/subagent/agents.ts` — `discoverAgents`, `AgentConfig`, `AgentScope`.
- `examples/extensions/interactive-shell.ts` — `ctx.ui.custom()` + `tui.stop()/start()` pattern for the `/attach` command (suspend TUI, run `tmux attach`, resume).

## Critical changes / new code

### 1. `tmux.ts` — new module

Functions:
- `isInsideTmux(): boolean` — check `process.env.TMUX` is set. The whole model assumes pi runs inside the user's tmux session.
- `isTmuxAvailable(): boolean` — `spawnSync("tmux", ["-V"])`. **Per AGENTS.md Rule 12: fail loud** — if tmux missing OR not inside tmux (`$TMUX` unset), the tool returns a clear error ("run pi inside tmux to use subagents"); do not silently fall back to hidden spawn.
- `runInWindow(opts): { windowId: string }` — write launcher script, `tmux new-window -d -n <label> -c <cwd> -P -F "#{window_id}" -- bash <launcher.sh>` in the **current** session (no `-t <session>`); parse stdout to capture the `@<id>` window id; track it in a module-level `Set<string>` of in-flight windows.
- `killWindow(windowId)` — `tmux kill-window -t <id>` (ignore errors, e.g. window already gone); remove from the in-flight set.
- `killAllWindows()` — iterate the in-flight set, `killWindow` each. Called on `session_shutdown`. **Never** calls `kill-session`.
- `capturePane(windowId): string` — `tmux capture-pane -p -t <id>` (optional, for diagnostics).

> **Removed:** `ensureSession()` and `killSession()`. No dedicated `pi-sub-<pid>` session is created; subagent windows live in the user's current session. There is no code path that kills a session.

Launcher script content (written per task, run with `bash`). **Changed: no keep-alive `read`.** When the launched process exits, the window's command ends and tmux closes the window automatically (default `remain-on-exit off`); the parent also explicitly `kill-window`s on completion as a deterministic backstop:
```bash
#!/usr/bin/env bash
cd "<cwd>"
"<pi-cmd>" --mode json -p --no-session [opts...] \
  --append-system-prompt "<prompt.md>" "Task: <task>" \
  > "<dir>/events.jsonl" 2> "<dir>/stderr.log"
echo $? > "<dir>/exit.marker"
# no keep-alive: window closes when this script exits; parent kill-windows as backstop
```
Resolve `<pi-cmd>` via the example's `getPiInvocation()` helper (handles bun virtual fs / generic node runtime / plain `pi`). Build the full argv there; write it into the script with proper shell quoting (single-quote each arg, escape embedded quotes). Writing to a script file sidesteps tmux's own quoting layer.

Use the example's `writePromptToTempFile` pattern (mode `0o600`, `withFileMutationQueue`) for `prompt.md`; place all per-task files under one `mkdtemp` dir so cleanup is a single `rm -rf` equivalent (`fs.rmSync(dir, {recursive:true})`).

### 2. `runSingleAgent` rewrite in `index.ts`

Replace the `spawn(...)` block. Keep the surrounding `SingleResult`, `emitUpdate`, abort wiring, and `finally` cleanup. New body:

```
if (!isTmuxAvailable() || !isInsideTmux()) throw new Error("tmux required: run pi inside tmux");
const dir = mkdtemp(...);           // per-task temp dir
writePromptFile(dir, agent.systemPrompt);
writeLauncher(dir, piArgv, task, cwd);
const { windowId } = runInWindow({ label: `${agentName}-${step ?? ""}`, cwd, dir }); // current session

// poll loop
let offset = 0;
let wasAborted = false;
await new Promise<void>((resolve) => {
  const tick = () => {
    // 1. read new bytes from events.jsonl starting at offset, split lines, processLine()
    // 2. if signal.aborted -> wasAborted = true -> resolve()
    // 3. if exit.marker exists -> do one FINAL read of remaining bytes -> read code -> resolve()
    // else setTimeout(tick, 250)
  };
  tick();
});
// always remove the subagent window once its process is done or aborted
killWindow(windowId);
if (wasAborted) throw new Error("Subagent aborted");
currentResult.exitCode = code;
// read stderr.log into currentResult.stderr
// finally: fs.rmSync(dir, { recursive: true })
```

Key change vs. old plan: `killWindow(windowId)` runs on **both** normal completion and abort — the window is removed as soon as the subagent process finishes. No window is left open for inspection (the parent's `renderResult` is the human-facing view). Nothing ever touches the session.

`processLine` is copied unchanged — it already handles `message_end` (usage/turns/model/stopReason/errorMessage) and `tool_result_end`.

Incremental read: `fs.openSync` + `fs.readSync` from `offset`, or `fs.createReadStream(path,{start:offset})`; keep a `buffer` for partial trailing lines exactly like the existing stdout handler.

### 3. Modes, schema, render — unchanged

Single / parallel (`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`) / chain (`{previous}`) orchestration, `SubagentParams` schema, `renderCall`, `renderResult` all carry over. Each parallel/chain task gets its own tmux window concurrently — naturally observable as multiple windows.

Rename tool `subagent` → `tmux_subagent` (or keep `subagent` but document it's tmux-backed). Update tool `description` to mention tmux windows + `/attach`.

### 4. `/attach` command — new

Because subagent windows live in the **current** session and are short-lived (killed on completion), `/attach` is really a **switch-window** within the current session, not a cross-session `tmux attach`:
```
pi.registerCommand("attach", { handler: async (args, ctx) => {
  // list THIS parent's in-flight windows from the tracked Set (or
  //   tmux list-windows -F "#{window_id} #{window_name}" filtered to tracked ids)
  // ctx.ui.select(...) to pick (or use args)
  // ctx.ui.custom(): tui.stop(); spawnSync("tmux", ["select-window","-t",windowId], {stdio:"inherit"}); tui.start(); done()
}});
```
Mirror `interactive-shell.ts` suspend/resume. After switching, the user uses normal tmux keys (Ctrl+B + window number, or Ctrl+B p) to return to the pi window. Guard `ctx.mode === "tui"`. If no windows tracked, report "no running subagents".

### 5. Lifecycle cleanup

```
pi.on("session_shutdown", () => { killAllWindows(); rmTempRoot(); });  // NEVER kill-session
```
`killAllWindows()` kills only the windows this parent still has in flight (tracked Set). Most windows are already gone (killed on completion); this catches any still-running at shutdown. The user's tmux session and their own windows are never touched.

Also reuse existing project-agent confirmation flow (`ctx.ui.confirm`) before running project-scoped agents.

## Existing functions/utilities to reuse (paths)

- `discoverAgents`, `AgentConfig`, `AgentScope` — `examples/extensions/subagent/agents.ts`
- `getAgentDir`, `parseFrontmatter`, `withFileMutationQueue`, `getMarkdownTheme` — `@mariozechner/pi-coding-agent`
- `getPiInvocation`, `writePromptToTempFile`, `formatUsageStats`, `formatToolCall`, `getDisplayItems`, `getFinalOutput`, `isFailedResult`, `getResultOutput`, `truncateParallelOutput`, `mapWithConcurrencyLimit` — copy from `examples/extensions/subagent/index.ts`
- `ctx.ui.custom` + `tui.stop()/start()/requestRender(true)` — pattern in `examples/extensions/interactive-shell.ts`
- TUI components `Container`, `Markdown`, `Spacer`, `Text` — `@mariozechner/pi-tui`
- Schema: `Type` from `typebox`, `StringEnum` from `@mariozechner/pi-ai`
- `AgentToolResult` — `@mariozechner/pi-agent-core`; `Message` — `@mariozechner/pi-ai`
- (See File layout: adapt all `@earendil-works/*` example imports to `@mariozechner/*`.)

## Edge cases / decisions

- **tmux missing OR not inside tmux (`$TMUX` unset)** → fail loud (return error), don't fall back silently (AGENTS.md Rule 12).
- **`pi` not on PATH in tmux shell** → resolve absolute path via `getPiInvocation()`, write into launcher; tmux spawns a login-ish shell but PATH may differ, so always use the resolved path.
- **Window lifetime**: window is **killed when its subagent process completes** (and on abort). No keep-open / `remain-on-exit` / `keepWindows` setting — removed. Parent's `renderResult` is the after-the-fact view; the live pane is only for watching in-progress.
- **Never kill-session**: pi runs inside the user's session; `kill-session` would close the user's whole session. Cleanup is strictly per-window. No dedicated `pi-sub-<pid>` session exists.
- **Concurrency**: parallel mode opens up to `MAX_CONCURRENCY` windows at once; each polls its own events file independently; each is killed as it finishes.
- **Orphan windows**: tracked in a module-level Set; `session_shutdown` kills any still in flight. A `/subagents` listing (or `/attach` with no arg) can show the live set. No orphan *sessions* are possible since none are created.
- **Final-read race**: when `exit.marker` appears, do one last incremental read of `events.jsonl` BEFORE `kill-window`, so trailing events aren't lost (events come from the file, not the pane, so kill-window can't truncate data — but read first for determinism).
- **Output size**: same 50 KB per-task cap for model-visible parallel output; full `Message[]` kept in tool details.
- **JSON readability in pane**: RAW JSONL only (decision #3). No `jq` detection. Human observability comes from watching the live window + the parent's structured `renderResult`, not from prettifying the pane.

## Verification (end-to-end)

Manual, interactive pi session **inside tmux**, extension auto-discovered from `./extensions/tmux-subagent/`. Sample agents available (repo `agents/` or `.pi/agents/`):

1. **tmux detection**: run pi outside tmux (`$TMUX` unset) or with tmux missing → tool returns clear error (no crash, no silent fallback).
2. **Single**: `Use scout to find all authentication code`.
   - Verify a window appears: `tmux list-windows`.
   - Verify streaming `onUpdate` shows tool calls live in pi.
   - Verify final result has agent output + usage stats.
   - Verify events file + exit.marker created, **window killed on completion**, temp dir cleaned.
3. **Switch/attach**: while a long task runs, `/attach` → select window → watch live JSONL → switch back to the pi window (Ctrl+B + number) → pi TUI restored cleanly.
4. **Parallel**: `Run 2 scouts in parallel...` → two windows concurrently, both stream, each killed as it finishes, both results returned; `2/2 done`.
5. **Chain**: `/implement add Redis caching ...` → scout→planner→worker windows in sequence, `{previous}` passed; stops at first failure.
6. **Abort**: start a task, press Ctrl+C → `tmux kill-window` removes the window, tool reports aborted, no orphan process (`pgrep -f "pi --mode json"`).
7. **Never kill-session**: quit pi (`/quit`) mid-run → `session_shutdown` kills only the in-flight subagent **window(s)**; the user's tmux **session survives** (`tmux has-session` succeeds, other windows intact). Confirm no `kill-session` is ever issued.
8. **Project agents**: with `agentScope:"both"` and a `.pi/agents/*.md`, confirm the `ctx.ui.confirm` gate fires.

Automated checks (repo tooling, AGENTS.md workflow) — run after implementation, before commit:
- `npm test` — unit tests under `test/extensions/tmux-subagent/` (tmux helper argv/launcher/window-id parsing with mocked `spawnSync`; poll-loop parsing + kill-on-complete against fixture JSONL). Report test count + pass/fail.
- `npm run typecheck`
- `npx eslint .`
- `npm run format:check`
- `mdl README.md docs/**/*.md` only if those docs change.

## Resolved decisions

1. **Scope/placement**: RESOLVED. This is a pi extension repository — build under `./extensions/tmux-subagent/` (auto-discovered via `package.json` `pi.extensions`). Tests under `test/extensions/tmux-subagent/`. Not `~/.pi/agent/extensions/`.
2. **Persistence on parent exit**: KILL subagents per-window. Each window is killed when its process completes or on abort; `session_shutdown` kills any still-in-flight **windows** + temp cleanup. **NEVER `kill-session`** — pi runs inside the user's session and killing it would close everything. No detach-and-leave-running mode; prevents orphan processes and orphan API spend.
3. **Pane display**: RAW JSONL. No `jq` dependency or detection. Pane shows the raw `--mode json` stream; structured/pretty view comes from the parent's `renderResult`.
4. **Import scope**: adapt example's `@earendil-works/*` imports to this runtime's `@mariozechner/*` packages (pi-agent-core, pi-ai, pi-coding-agent, pi-tui).
