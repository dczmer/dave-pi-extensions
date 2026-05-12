# Implementation Plan: pi-gate Extension

A minimalistic permissions gate for the pi agent with no external dependencies.

## Philosophy

1. Minimal, simple, no external dependencies
2. Bash commands "ask" by default, common safe commands white-listed
3. External file access "ask" by default, specific paths white-listed
4. Project files unrestricted by default, black-list for sensitive paths
5. Files in bash commands subject to external and project file rules

## 1. File Structure

Located under `extensions/pi-gate/` (project root) because this repo is a pi package
with `"extensions": ["./extensions"]` in `package.json`. Pi auto-discovers
`extensions/pi-gate/index.ts` as a directory-style extension.

```
extensions/pi-gate/
├── index.ts                # Entry point, tool_call event handler
├── pi-gate.json            # User configuration (created on first run)
├── config.ts               # Configuration loading/parsing/validation
├── matcher.ts              # Glob pattern matching utilities
├── session.ts              # Session state (in-memory approved paths/patterns)
├── guards.ts               # File path classification (external vs project)
├── prompts.ts              # User interaction logic (ctx.ui wrappers)
└── tests/
    ├── matcher.test.ts
    ├── guards.test.ts
    ├── session.test.ts
    ├── config.test.ts
    ├── prompts.test.ts
    ├── checkFileAccess.test.ts
    └── checkBashCommand.test.ts
```

## 2. Core Components

### 2.1 Configuration (`config.ts`)

```typescript
interface PiGateConfig {
  bashAllow: string[]; // Glob patterns for allowed bash commands
  externalAllow: string[]; // Glob patterns for allowed external paths
  projectDeny: string[]; // Glob patterns for blocked project paths
}

function loadConfig(cwd: string): PiGateConfig;
function saveConfig(cwd: string, config: PiGateConfig): void;
```

- Load `pi-gate.json` from `extensions/pi-gate/` (resolved relative to module)
- Strict validation on load: malformed JSON or missing/wrong-type sections throws
- Provide empty defaults if file missing
- Atomic save: write temp file, rename

### 2.2 Session State (`session.ts`)

```typescript
interface SessionState {
  approvedExternals: Set<string>; // Absolute paths approved this session
  approvedBashPatterns: Set<string>; // Glob patterns approved this session
}

function getSessionState(): SessionState;
function approveExternal(path: string): void;
function approveBashPattern(pattern: string): void;
function isExternalApproved(path: string): boolean;
function isBashPatternApproved(command: string): boolean;
```

- Module-level singleton for session persistence
- Resets when pi restarts (no disk persistence)

### 2.3 Path Classification (`guards.ts`)

```typescript
function classifyPath(filePath: string, cwd: string): 'project' | 'external';
function normalizePath(filePath: string): string; // Expand ~, resolve relative
function extractPathsFromCommand(command: string): string[]; // Simple tokenizer
```

- Determine if path is inside `cwd` (project) or outside (external)
- Handle `~` expansion and relative path resolution
- Naive parser to extract potential file paths from bash commands

### 2.4 Pattern Matching (`matcher.ts`)

```typescript
function matchesGlob(value: string, pattern: string): boolean;
function matchesAnyGlob(value: string, patterns: string[]): boolean;
```

- Minimal glob implementation (no dependencies)
- Support `*` (any chars) and `?` (single char)
- Match against full strings, not just substrings

### 2.5 User Prompts (`prompts.ts`)

```typescript
async function promptAllowDeny(message: string, ctx: ExtensionContext): Promise<boolean>;

async function promptPattern(suggestion: string, description: string, ctx: ExtensionContext): Promise<string | null>;

type ConfigSection = 'bashAllow' | 'externalAllow' | 'projectDeny';
async function confirmAddToConfig(section: ConfigSection, ctx: ExtensionContext): Promise<boolean>;
```

**Control flow for `promptAllowDeny`:**

1. Display `ctx.ui.confirm("pi-gate", message)`
2. Return boolean result

**Control flow for `promptPattern`:**

1. Display `ctx.ui.input("pi-gate", suggestion)` with description as label
2. On submit: if input trimmed to empty → return `null`; else → return trimmed
3. On cancel → return `null`

**Control flow for `confirmAddToConfig`:**

1. Display `ctx.ui.confirm("pi-gate", 'Add to pi-gate.json -> "${section}"?')`
2. Return boolean result

## 3. Tool Interception (`index.ts`)

Hook into pi's tool execution via `pi.on("tool_call")` event:

```typescript
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input (mutable)
  // Return { block: true, reason: "..." } to block
```

### 3.1 Read/Write/Edit/Grep/Find Handling

```typescript
async function checkFileAccess(
  filePath: string,
  cwd: string,
  config: PiGateConfig,
  ctx: ExtensionContext,
): Promise<boolean> {
  const normalized = normalizePath(filePath);
  const classification = classifyPath(normalized, cwd);

  if (classification === 'project') {
    // Blacklist check
    if (matchesAnyGlob(normalized, config.projectDeny)) {
      ctx.ui.notify(`Blocked: ${filePath} matches projectDeny pattern`, 'warning');
      return false;
    }
    return true;
  } else {
    // External whitelist check
    if (isExternalApproved(normalized)) return true;

    if (matchesAnyGlob(normalized, config.externalAllow)) return true;

    // Prompt user
    const allowed = await promptAllowDeny(`Allow access to external file: ${filePath}?`, ctx);
    if (!allowed) return false;

    approveExternal(normalized);

    // Ask to persist pattern
    if (await confirmAddToConfig('externalAllow', ctx)) {
      const pattern = await promptPattern(filePath, 'External path pattern', ctx);
      if (pattern) {
        config.externalAllow.push(pattern);
        saveConfig(cwd, config);
      }
    }
    return true;
  }
}
```

**Control flow:**

1. Normalize path (expand `~`, resolve relative)
2. Classify as `'project'` or `'external'`
3. If project: check against `projectDeny` globs → block if match, else allow
4. If external: check session approved list → allow if found
5. If external: check `externalAllow` globs → allow if match
6. If external no match: prompt user
7. If denied → return `false` (block)
8. If allowed → add to session approved list
9. Ask to persist pattern → if yes, prompt for pattern, save to config
10. Return `true`

### 3.2 Bash Tool Handling

```typescript
async function checkBashCommand(
  command: string,
  cwd: string,
  config: PiGateConfig,
  ctx: ExtensionContext,
): Promise<boolean> {
  const sessionState = getSessionState();

  // Step 1: Check command pattern
  const allPatterns = [...config.bashAllow, ...sessionState.approvedBashPatterns];
  let matchedPattern = allPatterns.find((p) => matchesGlob(command, p));

  if (!matchedPattern) {
    const allowed = await promptAllowDeny(`Allow bash command: ${command}?`, ctx);
    if (!allowed) return false;

    const pattern = await promptPattern(command, 'Command pattern', ctx);
    if (!pattern) return false;

    approveBashPattern(pattern);
    matchedPattern = pattern;

    if (await confirmAddToConfig('bashAllow', ctx)) {
      config.bashAllow.push(pattern);
      saveConfig(cwd, config);
    }

    // Re-check with updated patterns
    return checkBashCommand(command, cwd, config, ctx);
  }

  // Step 2: Extract and check file arguments
  const paths = extractPathsFromCommand(command);
  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd, config, ctx);
    if (!allowed) {
      ctx.ui.notify(`Blocked: file ${filePath} in command denied`, 'warning');
      return false;
    }
  }

  return true;
}
```

**Control flow:**

**Step 1 — Command Pattern Check:**

1. Combine `bashAllow` + `approvedBashPatterns`
2. Find first matching glob pattern for command
3. If match found → proceed to Step 2
4. If no match: prompt user
5. If denied → return `false`
6. If allowed → prompt for pattern (suggest exact command)
7. If pattern empty → return `false`
8. Add to session approved patterns
9. Ask to persist to config → if yes, save
10. **Recurse**: restart from Step 1 with updated patterns

**Step 2 — File Arguments Check:**

1. Extract potential file paths from command
2. For each path → call `checkFileAccess(path, cwd, config, ctx)`
3. If any file access denied → log, return `false`
4. If all files allowed → return `true`

## 4. Entry Point (`index.ts`)

```typescript
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    const config = loadConfig(ctx.cwd);

    if (event.toolName === 'bash') {
      const command = event.input.command as string;
      if (!command) return; // pass through

      const allowed = await checkBashCommand(command, ctx.cwd, config, ctx);
      if (!allowed) {
        return { block: true, reason: 'Blocked by pi-gate' };
      }
      return; // pass through
    }

    // File-access tools: read, write, edit, grep, find
    const fileTools = ['read', 'write', 'edit', 'grep', 'find'];
    if (fileTools.includes(event.toolName)) {
      const path = event.input.path as string | undefined;
      if (!path) return; // pass through

      const allowed = await checkFileAccess(path, ctx.cwd, config, ctx);
      if (!allowed) {
        return { block: true, reason: 'Blocked by pi-gate' };
      }
      return; // pass through
    }

    // All other tools pass through
  });
}
```

## 5. Implementation Order (Tests with Each Step)

Each step: write tests first, then implementation. Tests use Deno test runner
with `@std/testing/mock` for `spy`/`stub`, `@std/assert` for assertions,
and `@std/path` for path utilities.

### Step 1: Matcher (`tests/matcher.test.ts` → `matcher.ts`)

Pure function, no dependencies. Most straightforward to start with.

**Tests to write:**

- Exact string match (`ls` matches `ls`)
- Single wildcard `*` matches any chars
- Wildcard at end only (`cat *` matches `cat foo.txt`)
- Wildcard in middle (`file*.txt` matches `file123.txt`)
- Multiple wildcards (`*/*.txt` matches `src/main.txt`)
- `?` single character match
- `?` rejects zero chars
- `?` rejects multiple chars
- Pattern list: matchesAnyGlob first match
- Pattern list: matchesAnyGlob second match
- Pattern list: matchesAnyGlob no match
- Empty pattern returns false
- Empty value matches `*`
- Pattern equals value with literal `*` char
- Case sensitivity (Unix-style)
- Special regex chars treated as literal
- Pattern longer than value returns false
- Value longer than pattern returns false

### Step 2: Guards (`tests/guards.test.ts` → `guards.ts`)

Path classification and command parsing.

**Tests to write:**

- Project file classification (path under cwd)
- External file classification (path outside cwd)
- Tilde expansion to home directory
- Relative path resolution with `./`
- Relative path without dot prefix
- Extract simple file arguments from command
- Parent directory escape (`../../../etc/passwd` → external)
- Double slash normalization
- Trailing slash on directory
- Current directory redundancy (`./././file`)
- File at cwd boundary (cwd itself is project)
- Command with flags (flags filtered, paths extracted)
- Command with no paths returns empty array
- Quoted paths with spaces (document: naively parsed, quotes not handled)
- Environment variables not expanded (literal `$HOME` stays)

### Step 3: Session (`tests/session.test.ts` → `session.ts`)

In-memory state container.

**Tests to write:**

- Approve and check external path
- Approve and check bash pattern
- Multiple externals approved
- Multiple bash patterns approved
- getSessionState returns current state
- Unapproved external returns false
- Unapproved bash pattern returns false
- Session isolation (fresh session has no approvals)
- Approving same path twice is idempotent
- Approving same pattern twice is idempotent
- Empty session state (fresh sets are empty)

### Step 4: Config (`tests/config.test.ts` → `config.ts`)

JSON load/save with strict validation.

**Tests to write:**

- Load valid config file with all sections
- Load missing config returns empty defaults
- Save and reload roundtrip preserves data
- Append to bashAllow section
- Append to externalAllow section
- Malformed JSON throws error with clear message
- Missing bashAllow section throws error
- Missing externalAllow section throws error
- Missing projectDeny section throws error
- bashAllow is not array throws error
- externalAllow is not array throws error
- projectDeny is not array throws error
- Empty JSON object throws error
- Save creates parent directories if needed
- Atomic save operation (temp file + rename)

### Step 5: Prompts (`tests/prompts.test.ts` → `prompts.ts`)

User interaction wrappers. Use Deno mocking for ctx.ui methods.
Requires hooks to inject test double for `ctx`.

**Tests to write:**

- `promptAllowDeny` returns true when user selects Allow
- `promptAllowDeny` returns false when user selects Deny
- `promptPattern` returns edited value
- `promptPattern` returns null when input cleared
- `promptPattern` returns null on cancel
- `confirmAddToConfig` returns true when user selects Yes
- `confirmAddToConfig` returns false when user selects No
- `promptPattern` trims whitespace from input
- `promptPattern` empty string after trim returns null

### Step 6: File Access Guard (`tests/checkFileAccess.test.ts` → `index.ts` partial)

Wire checkFileAccess logic. Tests mock: loadConfig, normalizePath, classifyPath,
isExternalApproved, promptAllowDeny, approveExternal, confirmAddToConfig,
promptPattern, saveConfig.

**Tests to write:**

- Project file allowed with empty deny list
- Project file allowed when not matching deny pattern
- External file allowed when in config externalAllow
- External file allowed when in session approved list
- External file approved by user and persisted to config
- External file approved by user but not persisted (session-only)
- Project file blocked by exact deny pattern
- Project file blocked by glob deny pattern
- External file denied by user at prompt
- handleFileTools: read tool passes path check
- handleFileTools: write tool passes path check
- handleFileTools: edit tool passes path check
- handleFileTools: grep tool passes path check
- handleFileTools: find tool passes path check

### Step 7: Bash Guard (`tests/checkBashCommand.test.ts` → `index.ts` complete)

Wire checkBashCommand logic and final tool_call handler. Tests mock:
loadConfig, getSessionState, matchesGlob, promptAllowDeny, promptPattern,
approveBashPattern, confirmAddToConfig, saveConfig, extractPathsFromCommand,
checkFileAccess.

**Tests to write:**

- Command allowed by config bashAllow pattern
- Command allowed by session approved pattern
- Command with project files all allowed
- Command with external files all allowed
- No match prompts user, allows, persists, recurses, succeeds
- No match prompts user, allows, skips persist, recurses, succeeds
- Pattern matches but file access denies (blocked)
- User denies command at prompt (blocked)
- User allows command but clears pattern (blocked)
- Multiple files in command, one denied (whole command blocked)
- Command with no file arguments (automatic pass on file step)
- Recursion doesn't cause infinite loop (exactly 2 calls)
- Unknown tool name passes through (no block)
- Bash tool with empty command passes through

## 6. Deno Test Configuration

Update `deno.jsonc` imports and tasks:

```jsonc
{
  "tasks": {
    "test": "deno test --allow-read --allow-write --allow-env extensions/pi-gate/tests/",
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@1",
    "@std/testing": "jsr:@std/testing@1",
    "@std/path": "jsr:@std/path@1",
    "@std/fs": "jsr:@std/fs@1",
  },
}
```

- `--allow-read` — needed for config loading tests (real file I/O with temp dirs)
- `--allow-write` — needed for config saving tests
- `--allow-env` — needed for `$HOME` resolution in path normalization

## 7. Dependencies

**Runtime (no external deps):**

- `@mariozechner/pi-coding-agent` — types only (provided by pi runtime)
- Deno standard library (APIs, not imports) — `Deno.env`, `Deno.cwd`, `Deno.realPath`

**Test only:**

- `@std/assert` — assertions
- `@std/testing/mock` — `spy`, `stub`
- `@std/path` — path utilities for test fixtures
- `@std/fs` — temp directory creation for config tests

## 8. Edge Cases

- **Symlinks**: Resolve before classification to prevent escapes
- **Relative paths in bash**: Resolve against `cwd` before checking
- **Command pipes/separators**: Naive tokenizer — `|`, `&&`, `;` treated as regular tokens. Paths extracted literally. Composite commands are checked as a single string against patterns.
- **Glob vs regex**: Ensure user patterns use glob syntax (`*` not `.*`)
- **Config race**: File writes are atomic (write temp, rename)
- **Tilde expansion**: Handle `~` (home dir), not `~user`

## 9. No-Dependency Constraints

- Use `Deno` APIs for file operations (pi extensions run in Deno)
- Implement glob matching manually (~30 lines)
- Parse bash commands naively (split on spaces, filter obvious non-paths)
- No external crates/modules — pure TypeScript/Deno standard library
- `@std/*` imports allowed per project AGENTS.md for tests only
