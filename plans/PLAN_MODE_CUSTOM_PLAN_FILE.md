# Plan: Custom Plan File Selection for plan-mode

## Goal

Allow the user to specify or change the active planning file. The extension must support:

1. Starting a session with an existing plan file (e.g. `plans/PLAN_TMUX-SUBAGENTS.md`).
1. Switching plan files mid-session via `/plan <path>`.
1. Recognising natural-language requests like "load and refine plans/foo.md" and using that file instead of creating a new one.
1. Letting the model write to the selected file while keeping all other edits blocked.

## Clarified Decisions

- `--plan-file <path>` and `--no-plan` are mutually exclusive. Passing both raises an error.
- `--plan-file` applies to the initial agent session (`startup`/`resume`/`fork`/`reload`), not to `/new`. A new in-app session always starts a fresh plan.
- `/plan <path>` enables plan mode if it is currently disabled.
- Natural-language path detection runs before the `implement`/`commit` block.
- Supported path forms: relative, absolute, and quoted paths containing spaces.
- Path containment uses `resolve` + `normalize` against `cwd`; symlinks are not considered.
- Parent directories are **never** created for a custom plan path. The model may only create `.pi/artifacts`. Custom plan files must live in directories that already exist.
- When a custom plan path is active, `slug` is left empty/undefined in persisted state.
- The system prompt continues to say `mkdir` is allowed only under `.pi/artifacts`.

## Current Limitations

- The active plan file is derived automatically from the first user message as `.pi/artifacts/plan-<slug>.md`.
- The tool guard only allows writes to that auto-generated artifact path.
- No CLI flag or command argument can override the generated path.
- Persisted state stores only the slug, not an explicit path.

## Design

### Source of truth

Replace `currentPlanSlug` with `currentPlanPath: string | undefined`. The slug is still useful for naming auto-generated artifacts, but the path is what the guard and prompt use.

### CLI flag

Register a string flag `--plan-file <path>`.

- If the flag is provided and `--no-plan` is also provided, raise a user-facing error during `session_start`.
- If the flag is provided without `--no-plan`, resolve the path relative to `ctx.cwd`, validate it is inside `cwd`, and store it as `currentPlanPath`. The parent directory is **not** created.
- If `--no-plan` is provided without `--plan-file`, plan mode starts disabled and `currentPlanPath` stays undefined.

### `/plan` slash command

Change the handler so the argument string is interpreted as a plan file path.

- `/plan` with no argument toggles plan mode (current behaviour).
- `/plan <path>` switches the active plan file to the entire argument (after stripping a single pair of surrounding quotes) and enables plan mode if it is disabled.
- If the resolved path is a directory, reject it and notify the user.
- If the resolved path is outside `cwd`, reject it for safety.
- If the path does not exist yet, allow it; the next write will create it.

### Natural-language path detection

In the `input` handler, before running `isBlockedInput`, check whether the user input looks like a request to use an existing plan file. Supported patterns:

- `load plan from PATH`
- `use plan at PATH`
- `refine plan PATH`
- `switch plan to PATH`
- `continue plan PATH`

When a path is extracted and resolves inside `cwd`, set `currentPlanPath` and let the turn continue. The existing `[PLAN RE-ENTRY]` prompt will then tell the model to read the file first. If the path resolves outside `cwd`, notify the user and ignore it.

Extracted paths may be quoted to contain spaces. Strip one pair of surrounding quotes before resolution.

### Tool guard changes

`evaluateToolCall` should accept `currentPlanPath: string | undefined` instead of `currentPlanSlug`.

- In plan mode, `edit`/`write` are allowed only when the resolved target equals `currentPlanPath` or is under `/tmp`/the OS temp directory.
- All other `edit`/`write` calls are blocked.
- When `currentPlanPath` is `undefined`, every `edit`/`write` is blocked (generic plan mode).

### Bash guard

No behaviour changes. `mkdir` remains allowed only under `.pi/artifacts`. The model cannot create parent directories for custom plan paths; users must place custom plan files in existing directories.

### Prompt injection changes

The `before_agent_start` handler already accepts `planFilePath`. Use `currentPlanPath` directly. The existing `existsSync` check will inject the `[PLAN RE-ENTRY]` prefix for existing files and the normal planning prompt for new files.

Update `PLAN_PROMPT` and `GENERIC_PROMPT` so the `mkdir` rule still reads: `mkdir is allowed ONLY under .pi/artifacts/`.

### Persistence

Store the resolved absolute path in the `plan-mode-state` custom entry:

```json
{
  "enabled": true,
  "planPath": "/project/plans/PLAN_TMUX-SUBAGENTS.md"
}
```

`slug` is omitted when a custom path is active.

On `session_start`:

1. If `--plan-file` and `--no-plan` are both set, raise an error.
1. Else if `event.reason !== 'new'` and `--plan-file` is set, resolve and validate it as the active path.
1. Else if `event.reason !== 'new'`, restore `planPath` from the most recent persisted state if it is still inside `cwd`.
1. Else if `event.reason !== 'new'`, fall back to restoring `slug` and mapping it to `.pi/artifacts/<slug>.md` for backward compatibility.
1. Otherwise (`event.reason === 'new'`), leave `currentPlanPath` undefined so the session starts a fresh plan.

## File-by-File Tasks

### `extensions/plan-mode/plan-artifact.ts`

1. Add `resolvePlanFilePath(filePath: string, cwd: string): string` that resolves a possibly-relative path against `cwd` and normalises it.
1. Add `isPathWithinCwd(filePath: string, cwd: string): boolean` to reject paths that escape the project directory.
1. Keep existing helpers (`generateSlugFromText`, `isPlanArtifactPath`, `isTempPath`, `isUnderArtifactDir`) because they are still used by tests and by the bash guard.

### `extensions/plan-mode/index.ts`

1. Register `--plan-file` string flag.
1. Replace `let currentPlanSlug` with `let currentPlanPath`.
1. Add helper `setPlanPath(cwd: string, rawPath: string): { ok: true; path: string } | { ok: false; reason: string }` that resolves, validates within `cwd`, persists state, and notifies the user. Does **not** create parent directories.
1. Add helper `extractPlanPathFromInput(text: string, cwd: string): string | undefined` for natural-language path detection.
1. Update `session_start`:
   - Error if `--plan-file` and `--no-plan` are both set.
   - If `event.reason === 'new'`, reset `currentPlanPath` to `undefined`.
   - For other reasons, prefer `--plan-file`, then persisted `planPath`, then persisted `slug` mapped to `.pi/artifacts/<slug>.md`.
   - Validate restored/custom paths are within `cwd`.
   - Still ensure `.pi/artifacts` exists only when an auto-generated artifact path is active.
1. Update `/plan` command handler to parse the argument, switch path, and enable plan mode if needed.
1. Update `input` handler:
   - Try natural-language path detection first.
   - If no path is set, generate slug and set `currentPlanPath` to `.pi/artifacts/<slug>.md` on the first non-blocked message.
1. Update `before_agent_start` to compute `planFilePath` from `currentPlanPath`.
1. Update `tool_call` handler to pass `currentPlanPath` into `evaluateToolCall`.
1. Update `persist()` to include `planPath` and omit `slug` when a custom path is active.
1. Update prompt strings so the `mkdir` rule only mentions `.pi/artifacts`.

### `extensions/plan-mode/bash-guard.ts`

No changes required.

### `test/extensions/plan-mode/index.test.ts`

1. Update `evaluateToolCall` tests to pass `currentPlanPath` instead of `currentPlanSlug`.
1. Add tests for:
   - `--plan-file` flag resolving to an existing file and injecting `[PLAN RE-ENTRY]`.
   - `--plan-file` flag resolving to a non-existing file and injecting a normal planning prompt.
   - `--plan-file` and `--no-plan` together raise an error.
   - `/plan <path>` switching the active plan file and enabling plan mode when disabled.
   - `/plan <path>` rejecting a path outside `cwd`.
   - `/plan <path>` rejecting a directory.
   - Natural-language input setting the plan path before the `implement`/`commit` block runs.
   - Natural-language path outside `cwd` is rejected.
   - Quoted natural-language path with spaces is handled.
   - Persistence round-trip with `planPath`.
   - Backward compatibility: restoring from persisted `slug` still maps to `.pi/artifacts/<slug>.md`.
   - `session_start` with `reason: 'new'` resets `currentPlanPath` so a new in-app session does not inherit the previous plan file.
   - `session_start` with `reason: 'new'` ignores `--plan-file`.
   - Writing to the custom plan path is allowed.
   - Writing to a non-selected plan path is still blocked.

### `test/extensions/plan-mode/bash-guard.test.ts`

No new tests required. Existing `mkdir` coverage remains valid.

### `docs/extensions/plan-mode.md`

1. Document `--plan-file <path>`.
1. Document `/plan <path>`.
1. Document that custom plan files must live inside the project and in existing directories.
1. Document that `--plan-file` and `--no-plan` are mutually exclusive.
1. Remove the "Plan Artifact Auto-Rename" section.

## Example User Flows

### Start with an existing plan

```text
pi --plan-file plans/PLAN_TMUX-SUBAGENTS.md
```

Plan mode is active. The system prompt tells the model that `plans/PLAN_TMUX-SUBAGENTS.md` exists and to read it before refining. `edit`/`write` to that path are allowed.

### Switch mid-session

```text
/plan plans/PLAN_TMUX-SUBAGENTS.md
```

The active plan file changes. The next turn uses the new path in the prompt and guard.

### Natural language

```text
load and refine plans/PLAN_TMUX-SUBAGENTS.md
```

The input handler extracts the path, sets it as the active plan file, and the model proceeds in plan mode against that file.

## Acceptance Criteria

1. `pi --plan-file <path>` starts plan mode with the specified file.
1. Passing both `--plan-file` and `--no-plan` raises an error.
1. `/plan <path>` switches the active plan file and enables plan mode if needed.
1. The model can write to the selected file and nowhere else while plan mode is active.
1. Existing auto-generated `.pi/artifacts/plan-<slug>.md` behaviour still works when no path is specified.
1. Persisted sessions restore the active plan path across restarts.
1. `/new` starts a fresh plan and ignores any previously active custom path or `--plan-file`.
1. All existing tests pass and new tests cover the new paths.
