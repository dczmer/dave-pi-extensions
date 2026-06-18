# Plan: Custom Plan File Selection for plan-mode

## Goal

Allow the user to specify or change the active planning file. The extension must support:

1. Starting a session with an existing plan file (e.g. `plans/PLAN_TMUX-SUBAGENTS.md`).
1. Switching plan files mid-session via `/plan <path>`.
1. Recognising natural-language requests like "load and refine plans/foo.md" and using that file instead of creating a new one.
1. Letting the model write to the selected file while keeping all other edits blocked.

## Current Limitations

- The active plan file is derived automatically from the first user message as `.pi/artifacts/plan-<slug>.md`.
- The tool guard only allows writes to that auto-generated artifact path.
- No CLI flag or command argument can override the generated path.
- Persisted state stores only the slug, not an explicit path.
- `mkdir` is permitted only under `.pi/artifacts`, so a plan file outside that tree cannot have its parent directory created via bash.

## Design

### Source of truth

Replace `currentPlanSlug` with `currentPlanPath: string | undefined`. The slug is still useful for naming auto-generated artifacts, but the path is what the guard and prompt use.

### CLI flag

Register a string flag `--plan-file <path>`.

- If the flag is provided and plan mode is not explicitly disabled with `--no-plan`, resolve the path relative to `ctx.cwd`, store it as `currentPlanPath`, and ensure the parent directory exists (if the path is inside the project).
- If `--no-plan` is also set, the flag is ignored or stored for later use; plan mode starts disabled.

### `/plan` slash command

Change the handler so an optional argument is interpreted as a plan file path.

- `/plan` with no argument toggles plan mode (current behaviour).
- `/plan <path>` switches the active plan file to `<path>` (resolved relative to `cwd`).
- If the path is a directory, reject it and notify the user.
- If the resolved path is outside `cwd`, reject it for safety.
- If the path does not exist yet, allow it; the next write will create it.

### Natural-language path detection

In the `input` handler, before generating a new slug, check whether the user input looks like a request to use an existing plan file. Example patterns:

- `load plan from PATH`
- `use plan at PATH`
- `refine plan PATH`
- `switch plan to PATH`

When a path is extracted and resolves inside `cwd`, set `currentPlanPath` and let the turn continue. The existing `[PLAN RE-ENTRY]` prompt will then tell the model to read the file first.

### Tool guard changes

`evaluateToolCall` should accept `currentPlanPath` instead of `currentPlanSlug`.

- In plan mode, `edit`/`write` are allowed only when the resolved target equals `currentPlanPath` or is under `/tmp`/the OS temp directory.
- All other `edit`/`write` calls are blocked.
- When `currentPlanPath` is `undefined`, every `edit`/`write` is blocked (generic plan mode).

### Bash guard changes

Pass the active plan path into `isDestructiveCommand`.

- `mkdir` remains allowed under `.pi/artifacts`.
- `mkdir` is also allowed when every directory argument is a parent (or ancestor) of `currentPlanPath`. This lets the model create `plans/` or `docs/plans/` before writing the selected plan file.

### Prompt injection changes

The `before_agent_start` handler already accepts `planFilePath`. Use `currentPlanPath` directly. The existing `existsSync` check will inject the `[PLAN RE-ENTRY]` prefix for existing files and the normal planning prompt for new files.

### Persistence

Store the resolved absolute path in the `plan-mode-state` custom entry:

```json
{
  "enabled": true,
  "planPath": "/project/plans/PLAN_TMUX-SUBAGENTS.md",
  "slug": "plan-20260618-..."
}
```

On `session_start`:

1. Read `--plan-file` flag.
1. Otherwise restore `planPath` from the most recent persisted state.
1. Otherwise restore `slug` and map it to `.pi/artifacts/<slug>.md` for backward compatibility.
1. Otherwise leave `currentPlanPath` undefined (generic plan mode until the first user message).

When restoring a persisted path, verify it is still inside `cwd`; otherwise fall back to generic mode.

## File-by-File Tasks

### `extensions/plan-mode/plan-artifact.ts`

1. Add `resolvePlanFilePath(filePath: string, cwd: string): string` that resolves a possibly-relative path against `cwd` and normalises it.
1. Add `isPathWithinCwd(filePath: string, cwd: string): boolean` to reject paths that escape the project directory.
1. Add `isParentOrAncestorOf(planPath: string, dirPath: string, cwd: string): boolean` for the bash-guard `mkdir` exception.
1. Keep existing helpers (`generateSlugFromText`, `isPlanArtifactPath`, `isTempPath`, `isUnderArtifactDir`) because they are still used by tests and by the bash guard.

### `extensions/plan-mode/bash-guard.ts`

1. Change `isDestructiveCommand(command, cwd?, planPath?)` signature.
1. In the `mkdir` branch, also return safe when every target directory is a parent or ancestor of `planPath` (resolved against `cwd`).
1. Update unit tests in `test/extensions/plan-mode/bash-guard.test.ts`.

### `extensions/plan-mode/index.ts`

1. Register `--plan-file` string flag.
1. Replace `let currentPlanSlug` with `let currentPlanPath`.
1. Add helper `setPlanPath(cwd: string, path: string): boolean` that resolves, validates within `cwd`, ensures parent dir, persists state, and notifies the user.
1. Add helper `extractPlanPathFromInput(text: string, cwd: string): string | undefined` for natural-language path detection.
1. Update `session_start`:
   - Read `--plan-file`.
   - If `event.reason === 'new'`, reset `currentPlanPath` to `undefined` so the new session is not tied to the previous session's plan file.
   - For other reasons (`startup`, `resume`, `fork`, `reload`), restore `planPath` then `slug` from persisted state.
   - Validate restored path is within `cwd`.
1. Update `/plan` command handler to parse the argument and switch path when present.
1. Update `input` handler:
   - Try natural-language path detection first.
   - If no path is set, generate slug and set `currentPlanPath` to `.pi/artifacts/<slug>.md` on the first non-blocked message.
1. Update `before_agent_start` to compute `planFilePath` from `currentPlanPath`.
1. Update `tool_call` handler to pass `currentPlanPath` into `evaluateToolCall`.
1. Update `persist()` to include `planPath` in the entry data.

### `test/extensions/plan-mode/index.test.ts`

1. Update `evaluateToolCall` tests to pass `currentPlanPath` instead of `currentPlanSlug`.
1. Add tests for:
   - `--plan-file` flag resolving to an existing file and injecting `[PLAN RE-ENTRY]`.
   - `--plan-file` flag resolving to a non-existing file and injecting a normal planning prompt.
   - `/plan <path>` switching the active plan file.
   - `/plan <path>` rejecting a path outside `cwd`.
   - Natural-language input setting the plan path.
   - Persistence round-trip with `planPath`.
   - Backward compatibility: restoring from persisted `slug` still maps to `.pi/artifacts/<slug>.md`.
   - `session_start` with `reason: 'new'` resets `currentPlanPath` so a new in-app session does not inherit the previous plan file.
   - Writing to the custom plan path is allowed.
   - Writing to a non-selected plan path is still blocked.

### `test/extensions/plan-mode/bash-guard.test.ts`

1. Add tests for `mkdir` of a parent directory of the active plan path.
1. Add tests for `mkdir` of an unrelated directory still being blocked.

### `docs/extensions/plan-mode.md`

1. Document `--plan-file <path>`.
1. Document `/plan <path>`.
1. Document that plan mode can use any project-local markdown file, not only `.pi/artifacts` files.
1. Remove or update the "Plan Artifact Auto-Rename" section if it no longer matches the implementation.

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
1. `/plan <path>` switches the active plan file when plan mode is enabled.
1. The model can write to the selected file and nowhere else while plan mode is active.
1. Existing auto-generated `.pi/artifacts/plan-<slug>.md` behaviour still works when no path is specified.
1. Persisted sessions restore the active plan path across restarts.
1. All existing tests pass and new tests cover the new paths.
