# Apply Plan-Mode Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the code-review findings for commit `24649602ba678917f51b6c191dbd50aeb4503f0c` so the custom-plan-file feature is safe, backward-compatible, and well-tested.

**Architecture:** Centralize plan-path validation in `extensions/plan-mode/plan-artifact.ts`, make `extensions/plan-mode/index.ts` consume those helpers, persist backward-compatible `slug` for auto-generated artifact plans, and tighten natural-language path extraction. Add missing tests and update docs / `.gitignore`.

**Tech Stack:** TypeScript, Node.js built-ins (`node:fs`, `node:path`, `node:test`, `node:assert`), `@mariozechner/pi-coding-agent` APIs.

## Global Constraints

- Only Node.js built-ins (`node:*`), `@mariozechner/*`, and `bash-parser` imports at runtime.
- Tests use `node:test` and `node:assert`.
- Tests must never modify real user configuration files; use `withTempDir` tempfs isolation from `test/utils/temp-dir.ts`.
- No automatic package installation.
- All verification commands pass before finishing: `npm test`, `npm run typecheck`, `npx eslint .`, `npm run format:check`.
- No `git` commit or push without explicit user approval.

---

## File Structure

| File                                              | Responsibility                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/plan-mode/plan-artifact.ts`           | Path utilities: resolution, artifact detection, temp detection, **new** path validation, **new** extracted-path sanitization, **moved** `stripQuotes`.      |
| `extensions/plan-mode/index.ts`                   | Extension lifecycle, tool guard, slash command, CLI flags, persistence, natural-language path detection. Refactored to use helpers from `plan-artifact.ts`. |
| `test/extensions/plan-mode/plan-artifact.test.ts` | Unit tests for `plan-artifact.ts` helpers.                                                                                                                  |
| `test/extensions/plan-mode/index.test.ts`         | Integration tests for extension behavior.                                                                                                                   |
| `docs/extensions/plan-mode.md`                    | User-facing docs; add filesystem limitation note.                                                                                                           |
| `.gitignore`                                      | Ignore auto-generated `.pi/artifacts/` plan files.                                                                                                          |

---

## Task 1: Centralize plan-path validation in `plan-artifact.ts`

**Files:**

- Modify: `extensions/plan-mode/plan-artifact.ts`
- Test: `test/extensions/plan-mode/plan-artifact.test.ts`

**Interfaces:**

- Consumes: `resolvePlanFilePath`, `isPathWithinCwd` (same file).
- Produces: `export function isValidPlanFilePath(filePath: string, cwd: string): { ok: true } | { ok: false; reason: string }`.

### Step 1.1: Add imports and implementation

Add `dirname` to the `node:path` import and import `statSync` from `node:fs`.

```typescript
import { existsSync, mkdirSync, statSync } from 'node:fs';
```

Append this helper after `isPathWithinCwd`:

```typescript
/**
 * Validate that a plan file path is usable.
 *
 * Checks:
 * - path resolves inside cwd
 * - if it exists, it is not a directory
 * - if it does not exist, its parent directory exists
 * - permission errors are surfaced instead of treated as "does not exist"
 *
 * @param filePath - Relative or absolute path to validate.
 * @param cwd - Current working directory.
 * @returns Ok result, or an error reason.
 */
export function isValidPlanFilePath(filePath: string, cwd: string): { ok: true } | { ok: false; reason: string } {
  const resolved = resolvePlanFilePath(filePath, cwd);

  if (!isPathWithinCwd(resolved, cwd)) {
    return { ok: false, reason: `Plan file path must be inside project directory: ${filePath}` };
  }

  let stats;
  try {
    stats = statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: `Permission denied reading plan file path: ${filePath}` };
    }

    if (code === 'ENOENT') {
      const parent = dirname(resolved);
      try {
        const parentStats = statSync(parent);
        if (!parentStats.isDirectory()) {
          return { ok: false, reason: `Plan file parent is not a directory: ${parent}` };
        }
      } catch (parentErr) {
        const parentCode = (parentErr as NodeJS.ErrnoException).code;
        if (parentCode === 'ENOENT') {
          return { ok: false, reason: `Plan file parent directory does not exist: ${parent}` };
        }
        if (parentCode === 'EACCES' || parentCode === 'EPERM') {
          return { ok: false, reason: `Permission denied reading plan file parent directory: ${parent}` };
        }
        throw parentErr;
      }
      return { ok: true };
    }

    throw err;
  }

  if (stats.isDirectory()) {
    return { ok: false, reason: `Plan file path is a directory: ${filePath}` };
  }

  return { ok: true };
}
```

### Step 1.2: Add unit tests for `isValidPlanFilePath`

Add to `test/extensions/plan-mode/plan-artifact.test.ts`:

```typescript
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mock } from 'node:test';
import { statSync } from 'node:fs';
```

And add these tests after the `isPathWithinCwd` tests:

```typescript
test('isValidPlanFilePath: accepts existing file', () => {
  withTempDir('pi-plan-', (dir) => {
    const file = join(dir, 'plans', 'foo.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Plan');
    const result = isValidPlanFilePath(file, dir);
    strictEqual(result.ok, true);
  });
});

test('isValidPlanFilePath: accepts non-existing file in existing directory', () => {
  withTempDir('pi-plan-', (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const result = isValidPlanFilePath(join(dir, 'plans', 'foo.md'), dir);
    strictEqual(result.ok, true);
  });
});

test('isValidPlanFilePath: rejects path outside cwd', () => {
  withTempDir('pi-plan-', (dir) => {
    const result = isValidPlanFilePath('/other/foo.md', dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('must be inside project'));
  });
});

test('isValidPlanFilePath: rejects directory', () => {
  withTempDir('pi-plan-', (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const result = isValidPlanFilePath(join(dir, 'plans'), dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('is a directory'));
  });
});

test('isValidPlanFilePath: rejects missing parent directory', () => {
  withTempDir('pi-plan-', (dir) => {
    const result = isValidPlanFilePath(join(dir, 'missing', 'foo.md'), dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('parent directory does not exist'));
  });
});

test('isValidPlanFilePath: rejects permission error on target', () => {
  const statMock = mock.method(
    { statSync },
    'statSync',
    () => {
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
    { times: 1 },
  );
  try {
    const result = isValidPlanFilePath('/project/plans/foo.md', '/project');
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('Permission denied'));
  } finally {
    statMock.restore();
  }
});
```

### Step 1.3: Run new tests

```bash
node --test test/extensions/plan-mode/plan-artifact.test.ts
```

Expected: 6 new tests pass; existing tests still pass.

### Step 1.4: Commit

```bash
git add extensions/plan-mode/plan-artifact.ts test/extensions/plan-mode/plan-artifact.test.ts
git commit -m "feat(plan-mode): add isValidPlanFilePath helper with parent-dir and permission checks"
```

---

## Task 2: Refactor `setPlanPath` to use centralized validation

**Files:**

- Modify: `extensions/plan-mode/index.ts:1-10` and `extensions/plan-mode/index.ts:321-351`
- Test: `test/extensions/plan-mode/index.test.ts`

**Interfaces:**

- Consumes: `isValidPlanFilePath` from `plan-artifact.ts`.
- Produces: same `setPlanPath` return type; behavior unchanged except new error reasons.

### Step 2.1: Update imports in `index.ts`

Change:

```typescript
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
```

to:

```typescript
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
```

Add `isValidPlanFilePath` to the `plan-artifact.ts` import:

```typescript
import {
  generateSlugFromText,
  isPathWithinCwd,
  isPlanArtifactPath,
  isTempPath,
  resolvePlanFilePath,
  isValidPlanFilePath,
} from './plan-artifact.ts';
```

### Step 2.2: Replace `setPlanPath` body

Replace the existing `setPlanPath` implementation with:

```typescript
function setPlanPath(
  cwd: string,
  rawPath: string,
  ctx: ExtensionContext,
  options: { notify?: boolean } = {},
): { ok: true; path: string } | { ok: false; reason: string } {
  const unquoted = stripQuotes(rawPath);
  const resolved = resolvePlanFilePath(unquoted, cwd);

  const validation = isValidPlanFilePath(resolved, cwd);
  if (!validation.ok) {
    if (options.notify !== false) ctx.ui.notify(validation.reason, 'warning');
    return { ok: false, reason: validation.reason };
  }

  currentPlanPath = resolved;
  persist(cwd);
  if (options.notify !== false) {
    ctx.ui.notify(`Plan file set to ${resolved}`);
  }
  return { ok: true, path: resolved };
}
```

### Step 2.3: Add `/plan` and `--plan-file` missing-parent tests

In `test/extensions/plan-mode/index.test.ts`, add after the existing `/plan <path> rejects directory` test:

```typescript
test('/plan <path> rejects missing parent directory', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const ctx = await harness.command('plan').execute('missing/foo.md');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'parent directory does not exist',
      ),
    );
  });
});
```

Add after the existing `--plan-file non-existing file` test:

```typescript
test('session_start: --plan-file with missing parent directory warns', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? 'missing/foo.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'parent directory does not exist',
      ),
    );
  });
});
```

### Step 2.4: Run plan-mode tests

```bash
node --test test/extensions/plan-mode/index.test.ts
```

Expected: all tests pass, including 2 new ones.

### Step 2.5: Commit

```bash
git add extensions/plan-mode/index.ts test/extensions/plan-mode/index.test.ts
git commit -m "refactor(plan-mode): use isValidPlanFilePath in setPlanPath and test missing parent dirs"
```

---

## Task 3: Persist backward-compatible `slug` for artifact plans

**Files:**

- Modify: `extensions/plan-mode/index.ts:291-296` (`persist`), plus all `persist()` call sites.
- Test: `test/extensions/plan-mode/index.test.ts`

**Interfaces:**

- Consumes: `isPlanArtifactPath`, `basename` from `node:path`.
- Produces: `persist(cwd: string)`; persisted entry now contains `slug` when current plan is an artifact path.

### Step 3.1: Update `persist` and callers

Change `persist` to:

```typescript
function persist(cwd: string): void {
  const entry: { enabled: boolean; slug?: string; planPath?: string } = { enabled: planModeEnabled };
  if (currentPlanPath) {
    entry.planPath = currentPlanPath;
    if (isPlanArtifactPath(currentPlanPath, cwd)) {
      entry.slug = basename(currentPlanPath).replace(/\.md$/, '');
    }
  }
  pi.appendEntry('plan-mode-state', entry);
}
```

Add `basename` to the `node:path` import:

```typescript
import { resolve, normalize, basename } from 'node:path';
```

Update every call site to pass `cwd`:

1. In `setPlanPath`: already calls `persist(cwd)` from Task 2.
2. In `toggle`:

```typescript
function toggle(ctx: ExtensionContext): void {
  planModeEnabled = !planModeEnabled;
  if (planModeEnabled) {
    notifyEnabled(ctx);
  } else {
    notifyDisabled(ctx);
  }
  updateStatus(pi, planModeEnabled, ctx);
  persist(ctx.cwd);
}
```

3. In `input` handler, replace `persist();` with `persist(ctx.cwd);` (two occurrences: after auto-generated slug and after `/plan` enables mode).
4. In `session_start`, no direct `persist()` call; state is restored only.

### Step 3.2: Update persistence tests

Change the existing test `'persist: custom path stores planPath and omits slug'` to also assert the notify content is unchanged. It should still pass.

Add a new test after it:

```typescript
test('persist: artifact path stores both planPath and slug', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    // Generate an artifact plan by providing user input
    await harness.emitEvent('input', { text: 'Add caching layer to the API' });

    strictEqual((harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.callCount(), 1);
    const entry = (harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.calls[0]!
      .arguments[1] as {
      enabled: boolean;
      planPath?: string;
      slug?: string;
    };
    strictEqual(entry.enabled, true);
    ok(entry.planPath?.includes('.pi/artifacts/plan-'));
    ok(entry.slug?.startsWith('plan-'));
    strictEqual(entry.planPath?.endsWith(`${entry.slug}.md`), true);
  });
});
```

### Step 3.3: Run tests

```bash
node --test test/extensions/plan-mode/index.test.ts
```

Expected: persistence tests pass.

### Step 3.4: Commit

```bash
git add extensions/plan-mode/index.ts test/extensions/plan-mode/index.test.ts
git commit -m "feat(plan-mode): persist slug alongside planPath for artifact plans"
```

---

## Task 4: Tighten natural-language plan-path extraction

**Files:**

- Modify: `extensions/plan-mode/plan-artifact.ts` (add `stripQuotes` and `sanitizeExtractedPlanPath`)
- Modify: `extensions/plan-mode/index.ts` (remove local `stripQuotes`, update `extractPlanPathFromInput`, update import)
- Test: `test/extensions/plan-mode/index.test.ts`

**Interfaces:**

- Consumes: `stripQuotes` moved to `plan-artifact.ts`.
- Produces: `export function sanitizeExtractedPlanPath(rawPath: string): string | undefined`.

### Step 4.1: Move `stripQuotes` to `plan-artifact.ts`

Add this to `extensions/plan-mode/plan-artifact.ts` after the imports:

```typescript
/**
 * Strip one pair of surrounding quotes from a path argument.
 *
 * @param rawPath - Path that may be wrapped in quotes.
 * @returns Path with surrounding quotes removed.
 */
export function stripQuotes(rawPath: string): string {
  if (rawPath.length >= 2) {
    const first = rawPath[0];
    const last = rawPath[rawPath.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return rawPath.slice(1, -1);
    }
  }
  return rawPath;
}
```

### Step 4.2: Add `sanitizeExtractedPlanPath`

After `stripQuotes`, add:

```typescript
/**
 * Sanitize a path captured from natural-language input.
 *
 * Strips trailing prose after conjunctions/prepositions, removes quotes,
 * and rejects strings that do not look like file paths.
 *
 * @param rawPath - Path segment captured from user input.
 * @returns Cleaned path if it looks valid, otherwise undefined.
 */
export function sanitizeExtractedPlanPath(rawPath: string): string | undefined {
  let cleaned = stripQuotes(rawPath).trim();
  if (!cleaned) return undefined;

  // Strip trailing prose (e.g., "plans/foo.md and implement it").
  cleaned = cleaned.replace(/\s+(?:and|then|to|with|for|from|of|in|on|at|under|over|but|because|so|if|when)\b.*$/i, '');

  // Must look like a file path: contains a separator or has a file extension.
  if (!cleaned.includes('/') && !/\.[a-zA-Z0-9]+$/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}
```

### Step 4.3: Update `index.ts`

Remove the local `stripQuotes` function from `index.ts`.

Update the import from `plan-artifact.ts`:

```typescript
import {
  generateSlugFromText,
  isPathWithinCwd,
  isPlanArtifactPath,
  isTempPath,
  resolvePlanFilePath,
  isValidPlanFilePath,
  stripQuotes,
  sanitizeExtractedPlanPath,
} from './plan-artifact.ts';
```

Update `extractPlanPathFromInput`:

```typescript
/**
 * Extract a plan file path from natural-language user input.
 *
 * Supported patterns: "load plan from PATH", "use plan at PATH",
 * "refine plan PATH", "switch plan to PATH", "continue plan PATH".
 * Paths may be quoted to contain spaces; one surrounding pair is stripped.
 * Trailing prose after conjunctions is ignored.
 *
 * @param text - Raw user input.
 * @returns Cleaned path string, or undefined.
 */
export function extractPlanPathFromInput(text: string): string | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^(?:load plan from|load and refine|use plan at|use plan|refine plan|switch plan to|continue plan)\s+(.+)$/i,
  );
  return match?.[1] ? sanitizeExtractedPlanPath(match[1]) : undefined;
}
```

### Step 4.4: Update tests for extraction

Replace the existing quoted-path test with:

```typescript
test('extractPlanPathFromInput strips quotes from quoted path', () => {
  strictEqual(extractPlanPathFromInput('load plan from "plans/my plan.md"'), 'plans/my plan.md');
});
```

Add after it:

```typescript
test('extractPlanPathFromInput returns undefined for prose without path', () => {
  strictEqual(extractPlanPathFromInput('load and refine the plan'), undefined);
});

test('extractPlanPathFromInput ignores trailing prose after conjunction', () => {
  strictEqual(extractPlanPathFromInput('load plan from plans/foo.md and implement it'), 'plans/foo.md');
});

test('extractPlanPathFromInput accepts relative filename with extension', () => {
  strictEqual(extractPlanPathFromInput('use plan at plan.md'), 'plan.md');
});
```

### Step 4.5: Run tests

```bash
node --test test/extensions/plan-mode/index.test.ts
```

Expected: extraction tests pass; no false positives.

### Step 4.6: Commit

```bash
git add extensions/plan-mode/index.ts extensions/plan-mode/plan-artifact.ts test/extensions/plan-mode/index.test.ts test/extensions/plan-mode/plan-artifact.test.ts
git commit -m "feat(plan-mode): tighten natural-language plan path extraction"
```

---

## Task 5: Add test for `--plan-file` outside cwd

**Files:**

- Test: `test/extensions/plan-mode/index.test.ts`

**Interfaces:**

- Consumes: existing `createMockExtensionAPI`, `createExtensionContext`.

### Step 5.1: Add the test

Add after the existing `--plan-file with --no-plan raises error` test:

```typescript
test('session_start: --plan-file outside cwd warns', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? '/other/foo.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('must be inside project'));
    ok(result.systemPrompt.includes('PLANNING MODE ACTIVE'));
    strictEqual(result.systemPrompt.includes('/other/foo.md'), false);
  });
});
```

### Step 5.2: Run tests

```bash
node --test test/extensions/plan-mode/index.test.ts
```

Expected: new test passes.

### Step 5.3: Commit

```bash
git add test/extensions/plan-mode/index.test.ts
git commit -m "test(plan-mode): cover --plan-file outside cwd"
```

---

## Task 6: Ignore auto-generated `.pi/artifacts/` plan files

**Files:**

- Modify: `.gitignore`
- Modify: `docs/extensions/plan-mode.md`

**Interfaces:**

- Produces: `.pi/artifacts/` ignored by git; docs note about auto-created files.

### Step 6.1: Add `.pi/artifacts/` to `.gitignore`

Append to `.gitignore`:

```gitignore
# Auto-generated plan-mode artifacts
.pi/artifacts/
```

### Step 6.2: Verify no test leaks into repo root

Run full test suite:

```bash
npm test
```

After it finishes, verify no new files appear under `.pi/artifacts/` in the repo root:

```bash
git status --short
```

Expected: no untracked `.pi/artifacts/` files. If any appear, find the offending test by checking which test ran without `withTempDir` and fix it before proceeding.

### Step 6.3: Update docs

In `docs/extensions/plan-mode.md`, add after the "Hot-key and Options" section:

```markdown
## Generated Plan Files

When plan mode is active and no plan file has been selected, the extension
auto-creates a dated plan file under `.pi/artifacts/` inside the project
directory. These files are local working artifacts and should not be committed.
```

### Step 6.4: Commit

```bash
git add .gitignore docs/extensions/plan-mode.md
git commit -m "chore(plan-mode): ignore auto-generated .pi/artifacts plan files"
```

---

## Task 7: Document filesystem limitations of path validation

**Files:**

- Modify: `docs/extensions/plan-mode.md`

**Interfaces:**

- Produces: user-facing note about symlink and case-insensitive filesystem behavior.

### Step 7.1: Add limitation note

In `docs/extensions/plan-mode.md`, add after the "Tool Call Filter" section (or before "System Prompt"):

```markdown
## Path Validation Limitations

Plan-mode path checks resolve paths textually with `node:path.resolve` and
`normalize`. They do **not** follow symlinks and do **not** account for
case-insensitive filesystems. A symlink pointing outside the project directory
or a case-mismatched path may pass validation even though it refers to files
outside the intended scope.
```

### Step 7.2: Run markdown lint if available

```bash
mdl README.md docs/**/*.md
```

If `mdl` is unavailable, skip and note it in the acceptance report.

Expected: no lint errors. If ordered-list numbering needs normalization:

```bash
mdl -w README.md docs/**/*.md
```

### Step 7.3: Commit

```bash
git add docs/extensions/plan-mode.md
git commit -m "docs(plan-mode): note symlink and case-insensitive filesystem limitations"
```

---

## Task 8: Final verification

### Step 8.1: Run full verification commands

```bash
npm test
npm run typecheck
npx eslint .
npm run format:check
```

Expected: all pass.

### Step 8.2: Review diff

```bash
git diff --stat HEAD
```

Expected: changes limited to the files listed above.

### Step 8.3: Stage or leave unstaged

Do **not** commit without explicit user approval. If everything passes, report completion.

---

## Self-Review

### Spec coverage

| Review finding                         | Task covering it |
| -------------------------------------- | ---------------- |
| Parent directory must exist            | Task 1 + Task 2  |
| Backward-compatible `slug` persistence | Task 3           |
| Natural-language false positives       | Task 4           |
| Trailing prose capture                 | Task 4           |
| `--plan-file` outside cwd test         | Task 5           |
| Permission errors from `statSync`      | Task 1           |
| Untracked `.pi/artifacts/` file        | Task 6           |
| Symlink/case-insensitive docs          | Task 7           |

### Placeholder scan

No placeholders like "TBD", "TODO", "implement later", or vague instructions remain. Every step includes exact file paths, code snippets, and commands.

### Type consistency

- `isValidPlanFilePath` returns `{ ok: true } | { ok: false; reason: string }` and is consumed by `setPlanPath` with destructuring `validation.ok` / `validation.reason`.
- `persist(cwd: string)` receives `cwd` from all callers (`setPlanPath`, `toggle`, `input` handler).
- `sanitizeExtractedPlanPath` returns `string | undefined` and is used by `extractPlanPathFromInput`.
- `stripQuotes` is exported from `plan-artifact.ts` and imported into `index.ts`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-apply-plan-mode-review-fixes.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

Which approach would you like?
