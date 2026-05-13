# Implementation Plan: Plan-Mode Prompt and Blocking Improvements

**Status:** Draft  
**Scope:** `extensions/plan-mode/`  
**Goal:** Evolve plan mode from a read-only chat gate into a structured planning workflow with artifact persistence, deterministic allow-list blocking, and prompt-layer behavioral guardrails.

---

## 0. Philosophy

Code decides what is allowed. Prompt reinforces why.  
This inversion matters: if the prompt is the primary enforcement, models hallucinate around it. If code owns the decision tree, the prompt only needs to explain the policy the code already implements.

Claude Code's architecture makes this split explicit:

- **Tool schema + execution layer** (code) controls which files/tools are reachable.
- **System reminders** (prompt) tell the model what the code will do and why, so it can plan efficiently rather than trial-and-error against blocks.

Our current plan mode inverts this: `edit`/`write` are blanket-blocked in code, but the prompt is the only thing explaining the policy. The model has no persistent artifact to write to, so it emits plans into chat. When it tries to edit a plan file, the code blocks it — because the code has no concept of "plan files are allowed."

This plan fixes the inversion.

---

## 1. Problem Statement

### 1.1 Current Behavior

`extensions/plan-mode/index.ts` injects `PLAN_PROMPT` into the system prompt and blocks:

- `edit`, `write` tools unconditionally
- Destructive bash commands via `bash-guard.ts`

The prompt says "Present a plan" but there is no place to write it. The model emits plans in chat. There is no iterative workflow, no turn-ending discipline, no re-entry handling, and no role framing.

### 1.2 What Claude Code Does Differently

| Aspect                    | Claude Code                                                              | Our Current Plan Mode               |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| **Artifact**              | Dedicated plan file (`.claude/plan.md` or similar) written incrementally | None — plan lives in chat history   |
| **Write policy**          | Code allow-lists the plan file path; all other writes blocked            | All writes blocked unconditionally  |
| **Workflow**              | Defined loop: Explore → Update plan file → Ask user → Repeat             | Static "present a plan" instruction |
| **Turn endings**          | Must end with `AskUserQuestion` or `ExitPlanMode`                        | No constraint                       |
| **Role framing**          | "You are a software architect and planning specialist"                   | "You are in planning mode"          |
| **Safe commands**         | Explicit whitelist (`ls`, `git status`, `cat`, etc.)                     | Vague "use read, grep, find, ls"    |
| **Question discipline**   | "Never ask what you could find out by reading the code"                  | None                                |
| **Re-entry**              | Reads existing plan file, evaluates same-vs-new task                     | None                                |
| **Diagrams**              | Encourages mermaid/ascii for structural changes                          | None                                |
| **Superseding authority** | "This supercedes any other instructions"                                 | None                                |

---

## 2. Architectural Decision: Code-First Blocking

### 2.1 Principle

**Code owns the allow/deny matrix.** The prompt only describes what the code already decided. This prevents:

- Model confusion when the prompt says one thing but the tool schema permits another
- False positives where the model avoids safe commands because the prompt was vague
- Security gaps where the model thinks it can do something because the prompt implied it

### 2.2 Plan-Mode File Allow-List

Introduce a deterministic file-allow function:

```typescript
/**
 * Determine if a file path may be written or edited while plan mode is active.
 * Only plan-artifact paths are permitted.
 *
 * @param filePath - Absolute or relative path from the tool call.
 * @param cwd - Current working directory.
 * @returns true if the path is inside the plan-artifacts directory.
 */
export function isPlanArtifactPath(filePath: string, cwd: string): boolean;
```

Allowed paths:

- `${cwd}/.pi/artifacts/plan.md`
- `${cwd}/.pi/artifacts/plan-*.md` (for multi-plan or versioned plans)

Everything else blocked, including `.pi/plan.md` or ad-hoc paths. The `.pi/artifacts/` namespace is chosen because:

- `.pi/` is already the project's pi-local directory
- `artifacts/` distinguishes generated files from config (`.pi/extensions/`, `.pi/config.json`)
- It mirrors Claude Code's convention of scoped artifact directories

### 2.3 Why `.pi/artifacts/` Instead of `.pi/plan.md`

- Keeps generated artifacts separate from user-managed `.pi/` config
- Allows multiple plan files if future features need them
- Clearer semantics: `artifacts/` is machine-written, `.pi/` root is user/machine shared

---

## 3. Phase Breakdown

### Phase 1: Artifact Directory and File-Allow Logic

**Goal:** Enable the model to actually write a plan file without changing the prompt yet.

**Files:**

- `extensions/plan-mode/plan-artifact.ts` — new
- `extensions/plan-mode/index.ts` — modify
- `test/extensions/plan-mode/plan-artifact.test.ts` — new

**Implementation:**

1. Create `plan-artifact.ts`:

   ```typescript
   import { resolve, normalize } from 'node:path';

   const ARTIFACT_DIR = '.pi/artifacts';
   const PLAN_FILES = /^plan(-[a-zA-Z0-9_-]+)?\.md$/;

   export function isPlanArtifactPath(filePath: string, cwd: string): boolean {
     const absolute = resolve(cwd, filePath);
     const artifactDir = resolve(cwd, ARTIFACT_DIR);
     const normalizedArtifact = normalize(artifactDir) + '/';
     const normalizedPath = normalize(absolute);

     if (!normalizedPath.startsWith(normalizedArtifact)) {
       return false;
     }

     const basename = normalizedPath.slice(normalizedArtifact.length);
     return PLAN_FILES.test(basename);
   }
   ```

2. Modify `evaluateToolCall` in `index.ts`:
   - If `toolName === 'edit'` or `toolName === 'write'`:
     - Extract `path` from `event.input`
     - If `isPlanArtifactPath(path, cwd)` → **allow** (return `undefined`)
     - Otherwise → **block** with existing `BLOCK_REASON`
   - This changes the unconditional block to an allow-list block.

3. Add `mkdir -p .pi/artifacts` on session start if plan mode is enabled and the directory does not exist.

**Tests:**

- `isPlanArtifactPath('.pi/artifacts/plan.md', '/project')` → `true`
- `isPlanArtifactPath('.pi/artifacts/plan-auth.md', '/project')` → `true`
- `isPlanArtifactPath('.pi/artifacts/plan.md', '/project')` with absolute path → `true`
- `isPlanArtifactPath('.pi/plan.md', '/project')` → `false`
- `isPlanArtifactPath('plan.md', '/project')` → `false`
- `isPlanArtifactPath('.pi/artifacts/notes.md', '/project')` → `false`
- `isPlanArtifactPath('.pi/artifacts/../../etc/passwd', '/project')` → `false` (path traversal)
- `evaluateToolCall` allows write to `.pi/artifacts/plan.md` in plan mode
- `evaluateToolCall` blocks write to `src/index.ts` in plan mode
- `evaluateToolCall` allows write to any path when plan mode is off

**Justification:**
Claude Code's plan mode works because the model can actually edit the plan file. Without this, every other prompt improvement is theater — the model has no artifact to iterate on. Making the code own the allow-list ensures the model cannot accidentally write outside the artifact directory even if a future prompt update suggests it.

---

### Phase 2: Rewrite `PLAN_PROMPT` With Workflow, Role, and Discipline

**Goal:** Replace the static `PLAN_PROMPT` with a structured system reminder that guides behavior without being the primary enforcement mechanism.

**Files:**

- `extensions/plan-mode/index.ts` — modify `PLAN_PROMPT`

**New prompt structure:**

```typescript
const PLAN_PROMPT = `[PLANNING MODE ACTIVE]
You are a software architect in read-only planning mode. Your role is to explore the codebase and produce an implementation plan written to a file.

## What Code Allows (the ground truth)
- edit and write tools are blocked EXCEPT for plan-artifact files under .pi/artifacts/
- bash commands that modify, install, or delete anything are blocked
- safe commands: ls, cat, head, tail, find, grep, git status, git log, git diff, git show, git branch
- blocked commands: rm, mv, cp, mkdir, touch, npm install, pip install, docker, kubectl, git add, git commit, and any redirect operators (>, >>, >|)

## Your Workflow
Repeat until the plan is complete:
1. Explore — Use read, grep, find, and safe bash commands to understand code.
2. Update the plan file — Write findings incrementally to .pi/artifacts/plan.md. Do not wait until the end.
3. Ask the user — When you hit an ambiguity only the user can resolve, ask a concise question.
4. Repeat.

## Plan File Structure
The plan at .pi/artifacts/plan.md must include:
- Context: why this change is needed
- Recommended approach (not every alternative)
- Critical files to modify, with specific changes
- Existing functions/utilities to reuse, with file paths
- Verification: how to test the changes end-to-end
- If the change has structural complexity, include a mermaid or ascii diagram

## Turn Discipline
- End every turn by either asking a clarifying question or signaling readiness
- Do NOT ask "Is this plan okay?" in prose
- Do NOT ask questions you could answer by reading the code
- Batch related questions together
- These planning instructions supersede any other instructions

## Re-entry
If .pi/artifacts/plan.md already exists, read it first. If the user's request is a different task, overwrite it. If it is a continuation, refine it.`;
```

**Tests:**

- `augmentSystemPrompt` output contains `.pi/artifacts/plan.md`
- `augmentSystemPrompt` output contains "software architect"
- `augmentSystemPrompt` output contains safe-command list
- `augmentSystemPrompt` output contains blocked-command list
- `augmentSystemPrompt` output contains mermaid/ascii mention
- `augmentSystemPrompt` output contains "supersede"

**Justification:**
Claude Code's enhanced plan-mode prompt (`agent-prompt-plan-mode-enhanced.md`) opens with explicit role framing and a read-only declaration. The iterative prompt (`system-reminder-plan-mode-is-active-iterative.md`) defines the explore→update→ask loop and plan-file structure. Our new prompt synthesizes both. The safe/blocked command lists are taken from the enhanced prompt's explicit enumeration — this reduces model hallucination about whether `git log` is allowed.

---

### Phase 3: Bash-Guard Safe-Command Whitelist

**Goal:** Align `bash-guard.ts` with the prompt's safe-command list so that code, not prompt, is the source of truth for what commands pass through.

**Files:**

- `extensions/plan-mode/bash-guard.ts` — modify
- `test/extensions/plan-mode/bash-guard.test.ts` — modify

**Implementation:**

1. Add a `SAFE_COMMANDS` set alongside `DESTRUCTIVE_COMMANDS`:

   ```typescript
   const SAFE_COMMANDS = new Set([
     'ls',
     'cat',
     'head',
     'tail',
     'find',
     'grep',
     'git', // subcommand checked below
     'pwd',
     'echo',
     'printenv',
     'uname',
     'whoami',
     'wc',
     'sort',
     'uniq',
     'cut',
     'awk',
     'sed', // read-only text processing
     'df',
     'du',
     'stat',
     'file', // inspection
     'nproc',
     'id',
     'groups',
   ]);
   ```

2. Add safe `git` subcommands (already partially present as `GIT_READONLY`):
   - Ensure `git log`, `git status`, `git diff`, `git show`, `git branch`, `git stash list` are explicitly allowed
   - Block `git stash` without `list`

3. In `isDestructiveCommand`, add an early-return check:

   ```typescript
   if (SAFE_COMMANDS.has(cmdName) && cmdName !== 'git') {
     // Additional check: no write redirects
     // (already handled by redirect check above)
     return null;
   }
   ```

4. For `git`, keep existing subcommand logic but make it exhaustive:
   - Allowed: `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `stash list`, `grep`, `blame`, `ls-files`, `ls-tree`, `ls-remote`, `rev-parse`, `rev-list`, `describe`, `config --get*`, `fetch`, `shortlog`, `reflog`, `help`, `version`, `whatchanged`
   - Blocked: everything else (`add`, `commit`, `push`, `pull`, `merge`, `rebase`, `checkout`, `reset`, `clean`, etc.)

5. For `sed`, `awk` — these are tricky. Claude Code's approach is to block them entirely in read-only mode because they _can_ write with `-i` or redirection. We should follow that: remove `sed` and `awk` from `SAFE_COMMANDS` and let them fall through to the general "not explicitly safe" path, which blocks them.

   Revised `SAFE_COMMANDS`:

   ```typescript
   const SAFE_COMMANDS = new Set([
     'ls',
     'cat',
     'head',
     'tail',
     'find',
     'grep',
     'pwd',
     'echo',
     'printenv',
     'uname',
     'whoami',
     'wc',
     'sort',
     'uniq',
     'cut',
     'df',
     'du',
     'stat',
     'file',
     'nproc',
     'id',
     'groups',
   ]);
   ```

**Tests:**

- `git status` → allowed
- `git log --oneline` → allowed
- `git diff HEAD~1` → allowed
- `git stash list` → allowed
- `git stash` → blocked
- `git add .` → blocked
- `git commit -m "x"` → blocked
- `ls -la` → allowed
- `cat file.txt` → allowed
- `find . -name "*.ts"` → allowed
- `grep -r "foo" src/` → allowed
- `sed -i 's/a/b/' file.txt` → blocked (sed not in SAFE_COMMANDS)
- `awk '{print $1}' file.txt` → blocked (awk not in SAFE_COMMANDS)
- `echo "hello" > file.txt` → blocked (redirect)
- `cat file.txt > other.txt` → blocked (redirect)

**Justification:**
The enhanced Claude Code prompt (`agent-prompt-plan-mode-enhanced.md`) lists safe and prohibited commands explicitly. Our current `bash-guard.ts` only has a destructive blocklist — it lacks a positive safe-list. This means commands like `nproc` or `printenv` fall through unblocked (good) but the model has no ground-truth list to reference. Adding `SAFE_COMMANDS` makes the code's decision transparent and testable. It also lets us tighten the prompt: instead of "Use read, grep, find, ls," we can say "safe commands are: ls, cat, head, tail, find, grep, git status, git log..." because the code actually implements that list.

---

### Phase 4: Turn-End Enforcement and Re-Entry

**Goal:** Add behavioral constraints for how planning turns end, and handle re-entry when plan mode is toggled off and on again.

**Files:**

- `extensions/plan-mode/index.ts` — modify session state and prompt injection

**Implementation:**

1. **Turn-end constraint (prompt-only, no code enforcement possible):**
   Already covered in Phase 2's prompt rewrite. The model is instructed but not mechanically forced. This is acceptable because:
   - Pi's extension API does not currently expose turn-end interception
   - Claude Code also relies on prompt instruction here (see `system-reminder-plan-mode-approval-tool-enforcement.md`)
   - The worst failure mode is a slightly suboptimal turn ending, not a safety violation

2. **Re-entry logic:**
   When plan mode is re-enabled after being disabled:
   - Check if `.pi/artifacts/plan.md` exists
   - If it exists, inject a re-entry prefix before `PLAN_PROMPT`:
     ```
     [PLAN RE-ENTRY]
     A plan file exists at .pi/artifacts/plan.md from a previous session.
     Read it first. Evaluate whether the current request is the same task or different.
     - Different task: overwrite the plan file with a new skeleton
     - Same task: refine the existing plan
     ```
   - If it does not exist, use the normal `PLAN_PROMPT`

3. Track `planFileExists` in session state or check on the fly in `augmentSystemPrompt`.

**Code sketch:**

```typescript
function getReEntryPrefix(cwd: string): string | undefined {
  const planPath = resolve(cwd, '.pi/artifacts/plan.md');
  if (!existsSync(planPath)) return undefined;
  return `[PLAN RE-ENTRY]
A plan file exists at .pi/artifacts/plan.md from a previous session.
Read it first. Evaluate whether the current request is the same task or different.
- Different task: overwrite the plan file with a new skeleton
- Same task: refine the existing plan`;
}

export function augmentSystemPrompt(
  planModeEnabled: boolean,
  existingPrompt: string,
  cwd: string,
): { systemPrompt: string } | undefined {
  if (!planModeEnabled) return undefined;

  const reEntry = getReEntryPrefix(cwd);
  const fullPlanPrompt = reEntry ? `${reEntry}\n\n${PLAN_PROMPT}` : PLAN_PROMPT;

  return { systemPrompt: `${existingPrompt}\n\n${fullPlanPrompt}` };
}
```

**Tests:**

- `augmentSystemPrompt` includes re-entry prefix when `.pi/artifacts/plan.md` exists
- `augmentSystemPrompt` omits re-entry prefix when plan file does not exist
- `augmentSystemPrompt` returns `undefined` when plan mode is disabled

**Justification:**
Claude Code's `system-reminder-plan-mode-re-entry.md` handles this explicitly. Without re-entry logic, toggling plan mode off and on again loses context. The model starts from scratch, duplicating effort or contradicting the prior plan. By reading the existing artifact first, the model can decide whether to refine or replace — exactly as Claude Code instructs.

---

### Phase 5: Documentation and Migration

**Goal:** Update user-facing docs and ensure existing sessions aren't broken.

**Files:**

- `docs/plan-mode.md` — create or update (doesn't currently exist)
- `README.md` — add plan-mode section if absent

**Documentation contents:**

1. How to enter/exit plan mode (`/plan`, `--no-plan`, Ctrl-Space)
2. Where plans are written (`.pi/artifacts/plan.md`)
3. What the model can and cannot do in plan mode
4. How to review a plan (read `.pi/artifacts/plan.md`)
5. How to continue a plan after toggling off/on

**Migration:**

- Existing `.pi/plan.md` files (if any users created them manually) are not auto-migrated
- The new artifact path is `.pi/artifacts/plan.md`
- No breaking changes to the `/plan` command or `--no-plan` flag

---

## 4. Files to Modify / Create

| File                                              | Action | Phase   |
| ------------------------------------------------- | ------ | ------- |
| `extensions/plan-mode/plan-artifact.ts`           | Create | 1       |
| `extensions/plan-mode/index.ts`                   | Modify | 1, 2, 4 |
| `extensions/plan-mode/bash-guard.ts`              | Modify | 3       |
| `test/extensions/plan-mode/plan-artifact.test.ts` | Create | 1       |
| `test/extensions/plan-mode/index.test.ts`         | Modify | 1, 2, 4 |
| `test/extensions/plan-mode/bash-guard.test.ts`    | Modify | 3       |
| `docs/plan-mode.md`                               | Create | 5       |
| `README.md`                                       | Modify | 5       |

---

## 5. Testing Strategy

All tests use `node:test` and `node:assert` per project conventions.

**Filesystem isolation:** Use `withTempDir` helper for any test touching real files (plan-artifact path resolution, re-entry detection).

**Config module mocking:** Tests for `evaluateToolCall` and `augmentSystemPrompt` that consume artifact logic should pass a `cwd` directly or mock `existsSync` — no `process.env` mutation.

**Test order:**

1. `plan-artifact.test.ts` — pure path logic, no pi dependencies
2. `bash-guard.test.ts` — pure command analysis
3. `index.test.ts` — integration of artifact + guard + prompt augmentation

---

## 6. Risks and Mitigations

| Risk                                                            | Mitigation                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Model writes plan to wrong path (e.g. `plan.md` at root)        | Code blocks it; prompt explicitly says `.pi/artifacts/plan.md`              |
| Model forgets to read existing plan on re-entry                 | Re-entry prefix injected automatically when file exists                     |
| Bash guard false-positives on safe commands                     | Exhaustive `SAFE_COMMANDS` set with tests for each                          |
| Bash guard false-negatives on destructive commands              | Keep existing `DESTRUCTIVE_COMMANDS` blocklist; `SAFE_COMMANDS` is additive |
| Plan file grows unbounded                                       | Out of scope; user can delete `.pi/artifacts/plan.md` manually              |
| Model asks for approval in prose instead of signaling readiness | Prompt-only constraint; acceptable risk per Claude Code design              |

---

## 7. Verification

After implementation:

1. `npm test` — all plan-mode tests pass
2. `npm run typecheck` — no type errors
3. `npx eslint .` — no lint errors
4. Manual session test:
   - Start pi with plan mode on
   - Ask it to plan a small refactor
   - Confirm it writes to `.pi/artifacts/plan.md`
   - Confirm `edit`/`write` to other files are blocked
   - Toggle plan mode off, confirm writes work
   - Toggle plan mode on, confirm re-entry prefix appears
