# Implementation plan: tmux-backed observable subagents for pi coding agent

Build a pi extension that delegates tasks to subagents running as observable `pi` processes inside dedicated tmux windows in the user's current tmux session, replacing hidden child-process spawning with full pane visibility.

## Context

Pi has no built-in subagents by design. The existing `examples/extensions/subagent/` example spawns hidden `pi --mode json -p --no-session` child processes with piped stdio. This plan adapts that example to use tmux windows for observability, persistence across parent crashes, and direct interaction.

## Decisions

| Topic | Decision |
|-------|----------|
| Tool name | `tmux_subagent`. |
| Window lifetime after completion | **Kill immediately**. No orphan windows; human inspection is via the live pane while running and the parent's structured `renderResult` afterwards. |
| `/attach` command | **Drop it**. Users can switch to subagent windows with standard tmux bindings while a task runs; windows are killed on completion, making an attach command short-lived and fragile. |
| tmux missing / not inside tmux | Return a normal `AgentToolResult` with `content` describing the error and `isError: true`. Do not throw. |
| Plan mode in subagents | Pass `--no-plan` so child agents do not inherit plan-mode restrictions. |
| Temporary directories | Keep real directories under `/tmp/pi-tmux-sub/<session-id>/<agent>-<n>/` for CLI inspection. Clean up only on session end, new session start, or `/tmux-subagent-gc`. |

## Implementation

Reuse the JSON-event parsing, rendering, and agent-discovery logic from `examples/extensions/subagent/`. Replace only the execution backend.

1. **Detection**: `isTmuxAvailable()` runs `tmux -V`. `isInsideTmux(env?)` checks `TMUX`. If either fails, return a clear error result — no silent fallback.
2. **Session temp root**: On the first subagent call, create `sessionTempRoot = '/tmp/pi-tmux-sub/' + sanitize(ctx.sessionManager.getSessionId())`. Use `mkdirSync(sessionTempRoot, { recursive: true })`. The session id disambiguates multiple simultaneous pi sessions; `/tmp/pi-tmux-sub/` makes the root easy to discover from the shell.
3. **Per-task workspace**: Each task gets a deterministic but collision-safe directory under `sessionTempRoot`. Build a base name from the sanitized agent name plus an index, then create the directory with a loop that retries on `EEXIST`:
   - `/tmp/pi-tmux-sub/<session-id>/<agent>-0/`, `<agent>-1/`, etc.
   - `chain` mode uses the step number as the index.
   - `parallel` mode uses the task array index.
   - `single` mode uses `0`.
   - If the directory already exists (e.g. a repeated agent call), increment the index until `mkdirSync` succeeds.
   Inside the task dir write:
   - `prompt.md` — agent system prompt, mode `0o600`.
   - `launcher.sh` — bash script with absolute paths to `prompt.md`, `events.jsonl`, `stderr.log`, and `exit.marker`.
   - `events.jsonl`, `stderr.log`, `exit.marker` — created by the launcher via shell redirections.
4. **Launcher script**: shell script that `cd`s to cwd, runs the resolved `pi` invocation with `--mode json -p --no-session --no-plan [--model M] [--tools ...] --append-system-prompt prompt.md "Task: ..."`, redirects stdout to `events.jsonl` and stderr to `stderr.log`, then writes exit code to `exit.marker`.
4. **Window creation**: `tmux new-window -d -n <label> -c <cwd> -P -F "#{window_id}" -- bash <launcher.sh>` in the current tmux session (no `-t <session>`). Capture the `@<id>` window id.
5. **Poll loop** (~250 ms): incrementally read new bytes from `events.jsonl`, feed lines through the same `processLine` parser as the example, emit `onUpdate`, and accumulate `Message[]` / usage. When `exit.marker` appears, do one final read, capture exit code, then `tmux kill-window -t @id`.
6. **Abort**: on `signal.aborted`, set `wasAborted = true`, stop polling, and `tmux kill-window -t @id`.
7. **Shutdown**: on `session_shutdown`, kill any windows still in the in-flight set and remove the temp root dir. Never `kill-session`.

## Architecture

```
parent pi (inside user's tmux session)
  └─ extension: tmux-subagent
       ├─ registerTool("tmux_subagent")
       ├─ on(session_shutdown) -> kill in-flight windows + rm tmpdir
       │
       ▼ per task
   /tmp/pi-tmux-sub/<session-id>/
   └── <agent>-<n>/
       ├── prompt.md
       ├── launcher.sh
       ├── events.jsonl
       ├── stderr.log
       └── exit.marker
       │
       ▼
   tmux new-window -n <label> -c <cwd> ... bash launcher.sh
       │
       ▼ poll loop
   read events.jsonl  ──► processLine() ──► onUpdate(stream)
   exit.marker exists ──► final read ──► kill-window
```

## File layout

Directory extension under `./extensions/tmux-subagent/`:

- `index.ts` — tool registration, modes, render, temp directory management, `/tmux-subagent-gc` command (adapted from example).
- `agents.ts` — agent discovery + frontmatter parsing (adapted from example, imports fixed).
- `tmux.ts` — tmux availability, window lifecycle, pane capture, in-flight tracking.
- `agents/*.md` and `prompts/*.md` — copied sample agents/prompts from the example.

Tests under `test/extensions/tmux-subagent/`:

- `tmux.test.ts` — argv/launcher construction, window-id parsing, kill-window paths, fail-loud checks using mocked `node:child_process`.
- `index.test.ts` — poll loop against fixture `events.jsonl`, no per-task cleanup, GC command cleanup, abort path.

No `package.json` in the extension directory.

## Critical code details

### `tmux.ts`

```typescript
export function isTmuxAvailable(): boolean;
export function isInsideTmux(env?: NodeJS.ProcessEnv): boolean;
export interface TmuxWindowOptions {
  label: string;
  cwd: string;
  launcherPath: string;
}
export function runInWindow(opts: TmuxWindowOptions): { windowId: string };
export function killWindow(windowId: string): void;
export function killAllWindows(): void;
export function capturePane(windowId: string): string;
```

- Use a module-level `Set<string>` for in-flight window ids.
- `runInWindow` returns the parsed `@<n>` id from `tmux new-window -P -F "#{window_id}"`.
- Sanitize `label` to `[^a-zA-Z0-9_-]` and truncate to keep tmux happy.
- All tmux calls use `execFileSync` or `spawnSync` with `{ stdio: ['ignore', 'pipe', 'pipe'] }`.

### Temporary directory and file management

- **Session root**: `sessionTempRoot` is a module-level variable created lazily on the first subagent invocation:
  ```typescript
  sessionTempRoot = path.join('/tmp/pi-tmux-sub', sanitize(ctx.sessionManager.getSessionId()));
  fs.mkdirSync(sessionTempRoot, { recursive: true });
  ```
  The `/tmp/pi-tmux-sub/` prefix is predictable for shell inspection; the session id keeps simultaneous pi sessions separate.
- **Per-task dir**: build a base name from the sanitized agent name and an index, then create with collision retry:
  ```typescript
  let index = 0;
  const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
  while (true) {
    const taskDir = path.join(sessionTempRoot, `${safeAgentName}-${index}`);
    try {
      fs.mkdirSync(taskDir, { recursive: false });
      return taskDir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        index++;
        continue;
      }
      throw err;
    }
  }
  ```
  For `single` mode use index `0`; for `chain` use the 1-based step number; for `parallel` use the array index. If the same agent is invoked repeatedly, the index increments and creates a new inspectable directory.
- **File paths**: all paths written into `launcher.sh` are absolute (`${taskDir}/events.jsonl`, etc.), so the child's working directory does not affect them.
- **Writes**: `prompt.md` is written through `withFileMutationQueue` with mode `0o600`. `launcher.sh` is written with mode `0o600` and invoked explicitly as `bash launcher.sh`, so the executable bit is unnecessary.
- **Reads**: the parent reads `events.jsonl` incrementally via `fs.openSync`/`fs.readSync` or `fs.createReadStream({ start: offset })`. It should tolerate the file not existing yet on the first poll.
- **Cleanup triggers**:
  - `session_shutdown` — after killing in-flight windows, run `rmSync(sessionTempRoot, { recursive: true, force: true })` and reset `sessionTempRoot`.
  - `session_start` with `reason === 'new'` — before creating a new root, remove the previous `sessionTempRoot` if it exists (prevents leaking temp dirs across explicit `/new` sessions).
  - `/tmux-subagent-gc` command — immediately remove the current `sessionTempRoot` and reset it; active task dirs are skipped if any windows are still in flight, otherwise the entire root is removed.

### `index.ts` runner rewrite

```typescript
let sessionTempRoot: string | undefined;

function ensureSessionTempRoot(): string {
  if (!sessionTempRoot) {
    sessionTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tmux-sub-XXXXXX'));
  }
  return sessionTempRoot;
}

// inside runSingleAgent:
const safeAgentName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
const taskDir = allocateTaskDir(ensureSessionTempRoot(), safeAgentName, step ?? index ?? 0);
const promptPath = path.join(taskDir, 'prompt.md');
const launcherPath = path.join(taskDir, 'launcher.sh');
const eventsPath = path.join(taskDir, 'events.jsonl');
const stderrPath = path.join(taskDir, 'stderr.log');
const exitPath = path.join(taskDir, 'exit.marker');

// write prompt.md and launcher.sh

const baseArgs: string[] = ['--mode', 'json', '-p', '--no-session', '--no-plan'];
// ... push model, tools, --append-system-prompt promptPath, and task
const invocation = getPiInvocation(baseArgs);
// launcher.sh: cd cwd; invocation > eventsPath 2> stderrPath; echo $? > exitPath

const windowLabel = `${safeAgentName}-${path.basename(taskDir)}`;
const { windowId } = runInWindow({ label: windowLabel, cwd, launcherPath });

let offset = 0;
let buffer = '';
let wasAborted = false;
const exitCode = await new Promise<number>((resolve) => {
  const tick = () => {
    if (signal?.aborted) {
      wasAborted = true;
      return resolve(1);
    }
    // incremental read events.jsonl from offset
    // processLine() each complete line
    // if exit.marker exists -> final read -> read code -> resolve(code)
    // else setTimeout(tick, 250)
  };
  tick();
});

killWindow(windowId);
if (wasAborted) throw new Error('Subagent aborted');
currentResult.exitCode = exitCode;
currentResult.stderr = fs.readFileSync(stderrPath, 'utf-8');
// note: taskDir is intentionally NOT deleted here; it persists for inspection
```

### Style and API constraints

- Repo uses Prettier with `singleQuote: true`; implementation uses single quotes.
- Import `Type` from `@mariozechner/pi-ai` (it re-exports `Type` from `typebox`).
- `isInsideTmux` accepts an optional `env` parameter so tests can avoid mutating `process.env`.
- `ExtensionCommandContext` has no `mode` field; use `ctx.hasUI` when checking UI availability.
- Keep per-task directories under `/tmp/pi-tmux-sub/<session-id>/` for shell inspection; clean up only on session end, new session, or `/tmux-subagent-gc`.

## Existing utilities to reuse

From `examples/extensions/subagent/`:

- `discoverAgents`, `AgentConfig`, `AgentScope` -> rewrite imports to `@mariozechner/pi-coding-agent`.
- `getPiInvocation`, `writePromptToTempFile`, `formatUsageStats`, `formatToolCall`, `getDisplayItems`, `getFinalOutput`, `isFailedResult`, `getResultOutput`, `truncateParallelOutput`, `mapWithConcurrencyLimit`, `renderCall`, `renderResult`.

From `@mariozechner/pi-coding-agent`:

- `ExtensionAPI`, `getMarkdownTheme`, `withFileMutationQueue`, `getAgentDir`, `parseFrontmatter`.

From `@mariozechner/pi-ai`:

- `Message`, `StringEnum`, `Type`.

From `@mariozechner/pi-agent-core`:

- `AgentToolResult`.

From `@mariozechner/pi-tui`:

- `Container`, `Markdown`, `Spacer`, `Text`.

## Verification

### Automated

- `npm test` — new tests under `test/extensions/tmux-subagent/`.
- `npm run typecheck`.
- `npx eslint .`.
- `npm run format:check`.
- `mdl README.md docs/**/*.md` only if docs change.

### Manual (inside tmux)

1. Outside tmux or with tmux missing: tool returns error, no fallback.
2. Single agent: window appears, streaming updates work, final result returned, window killed, tmpdir cleaned.
3. Parallel: up to 4 concurrent windows, each killed on completion, aggregate results returned.
4. Chain: sequential windows, `{previous}` substitution, stops on first failure.
5. Abort: Ctrl+C kills the window and reports aborted.
6. Quit pi mid-run: `session_shutdown` kills only in-flight windows; user session survives.
7. Project agents: confirmation gate fires for project-scoped agents.
