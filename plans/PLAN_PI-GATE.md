# Implementation Plan: pi-gate Extension

A minimalistic permissions gate for the pi agent with no external dependencies.

## Philosophy

1. Minimal, simple, no external dependencies
2. Bash commands "ask" by default, common safe commands white-listed
3. External file access "ask" by default, specific paths white-listed
4. Project files unrestricted by default, black-list for sensitive paths
5. Files in bash commands subject to external and project file rules

## 1. File Structure

```
.pi/extensions/pi-gate/
├── extension.json          # Standard pi extension manifest
├── pi-gate.json            # User configuration (bashAllow, externalAllow, projectDeny)
├── mod.ts                  # Main entry, tool interception
├── config.ts               # Configuration loading/parsing
├── matcher.ts              # Glob pattern matching utilities
├── session.ts              # Session state (approved externals, approved bash patterns)
├── guards.ts               # File path classification (external vs project)
└── prompts.ts              # User interaction logic
```

## 2. Core Components

### 2.1 Configuration (`config.ts`)

```typescript
interface PiGateConfig {
  bashAllow: string[];      // Glob patterns for allowed bash commands
  externalAllow: string[];  // Glob patterns for allowed external paths
  projectDeny: string[];    // Glob patterns for blocked project paths
}

function loadConfig(cwd: string): PiGateConfig;
function saveConfig(cwd: string, config: PiGateConfig): void;
```

- Load `pi-gate.json` from `.pi/extensions/pi-gate/`
- Provide defaults if file missing
- Helper to update specific sections (append new patterns)

### 2.2 Session State (`session.ts`)

```typescript
interface SessionState {
  approvedExternals: Set<string>;     // Absolute paths approved this session
  approvedBashPatterns: Set<string>;  // Glob patterns approved this session
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
function normalizePath(filePath: string): string;  // Expand ~, resolve relative
function extractPathsFromCommand(command: string): string[];  // Simple tokenizer
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
async function promptAllowDeny(message: string): Promise<boolean>;

async function promptPattern(
  suggestion: string, 
  description: string
): Promise<string | null>;

type ConfigSection = 'bashAllow' | 'externalAllow' | 'projectDeny';
async function confirmAddToConfig(section: ConfigSection): Promise<boolean>;
```

**Control flow for `promptAllowDeny`:**
1. Print `[message]` in bold/highlighted
2. Present two options: `[Allow]` `[Deny]`
3. Wait for user selection
4. Return boolean result

**Control flow for `promptPattern`:**
1. Print: `Save this [description]? Edit the value below or clear to skip.`
2. Show text input pre-filled with `suggestion`
3. On submit:
   - If input empty → return `null`
   - Else → return trimmed input
4. On cancel → return `null`

**Control flow for `confirmAddToConfig`:**
1. Print: `Add to pi-gate.json -> "${section}"?`
2. Present `[Yes]` `[No]` options
3. Return true if Yes, false if No

## 3. Tool Interception (`mod.ts`)

Hook into pi's tool execution via `beforeToolCall` middleware:

```typescript
export async function beforeToolCall(
  toolName: string, 
  args: Record<string, any>
): Promise<{ proceed: boolean; args?: Record<string, any> }>;
```

### 3.1 Read/Write/Edit Handling

```typescript
async function checkFileAccess(filePath: string, cwd: string): Promise<boolean> {
  const normalized = normalizePath(filePath);
  const classification = classifyPath(normalized, cwd);
  const config = loadConfig(cwd);  // Load once
  
  if (classification === 'project') {
    // Blacklist check
    if (matchesAnyGlob(normalized, config.projectDeny)) {
      console.error(`Blocked: ${filePath} matches projectDeny pattern`);
      return false;
    }
    return true;
  } else {
    // External whitelist check
    if (isExternalApproved(normalized)) return true;
    
    if (matchesAnyGlob(normalized, config.externalAllow)) return true;
    
    // Prompt user
    const allowed = await promptAllowDeny(`Allow access to external file: ${filePath}?`);
    if (!allowed) return false;
    
    approveExternal(normalized);
    
    // Ask to persist pattern
    if (await confirmAddToConfig('externalAllow')) {
      const pattern = await promptPattern(filePath, 'External path pattern');
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
3. Load config once
4. If project: check against `projectDeny` globs → block if match, else allow
5. If external: check session approved list → allow if found
6. If external: check `externalAllow` globs → allow if match
7. If external no match: prompt user with `Allow access to external file: [path]?`
8. If denied → return `false` (block)
9. If allowed → add to session approved list
10. Ask `Add to pi-gate.json -> "externalAllow"?`
11. If yes → prompt for pattern (suggest full path) → save to config if provided
12. Return `true`

### 3.2 Bash Tool Handling

```typescript
async function checkBashCommand(command: string, cwd: string): Promise<boolean> {
  // Step 1: Check command pattern
  const config = loadConfig(cwd);
  const sessionState = getSessionState();
  
  const allPatterns = [...config.bashAllow, ...sessionState.approvedBashPatterns];
  let matchedPattern = allPatterns.find(p => matchesGlob(command, p));
  
  // No Match: Prompt user
  if (!matchedPattern) {
    const allowed = await promptAllowDeny(`Allow bash command: ${command}`);
    if (!allowed) return false;
    
    // Get pattern from user
    const pattern = await promptPattern(command, 'Command pattern');
    if (!pattern) return false;
    
    approveBashPattern(pattern);
    matchedPattern = pattern;
    
    // Persist to config?
    if (await confirmAddToConfig('bashAllow')) {
      config.bashAllow.push(pattern);
      saveConfig(cwd, config);
    }
    
    // Restart check with new pattern (tail recursion)
    return checkBashCommand(command, cwd);
  }
  
  // Step 2: Extract and check file arguments
  const paths = extractPathsFromCommand(command);
  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd);
    if (!allowed) {
      console.error(`Blocked: file ${filePath} in command denied`);
      return false;
    }
  }
  
  return true;
}
```

**Control flow:**

**Step 1 — Command Pattern Check:**
1. Load config once
2. Get session state
3. Combine `bashAllow` + `approvedBashPatterns`
4. Find first matching glob pattern for command
5. If match found → proceed to Step 2
6. If no match:
   - Prompt: `Allow bash command: [command]?`
   - If denied → return `false`
   - If allowed → prompt for pattern (suggest exact command)
   - If pattern empty → return `false`
   - Add to session approved patterns
   - Ask `Add to pi-gate.json -> "bashAllow"?`
   - If yes → append to config, save
   - **Tail recursion**: restart from Step 1 with updated patterns

**Step 2 — File Arguments Check:**
1. Extract potential file paths from command
2. For each path → call `checkFileAccess(path, cwd)`
3. If any file access denied → log error, return `false`
4. If all files allowed → return `true`

## 4. Extension Manifest (`extension.json`)

```json
{
  "name": "pi-gate",
  "version": "1.0.0",
  "main": "mod.ts",
  "hooks": {
    "beforeToolCall": "beforeToolCall"
  }
}
```

## 5. Implementation Order

1. **Matcher** - Core glob logic, unit test patterns
2. **Guards** - Path classification, test with various path formats
3. **Session** - Simple state container
4. **Config** - JSON load/save with defaults
5. **Prompts** - Integration with pi prompt API
6. **File Guards** - Read/write/edit interception
7. **Bash Guard** - Command parsing + file arg checking
8. **Integration** - Wire into `beforeToolCall`, handle all tool types

## 6. Edge Cases

- **Symlinks**: Resolve before classification to prevent escapes
- **Relative paths in bash**: Resolve against `cwd` before checking
- **Command pipes**: Parse `|` and `&&`, check each segment separately
- **Glob vs regex**: Ensure user patterns use glob syntax (`*` not `.*`)
- **Config race**: File writes are atomic (write temp, rename)
- **Tilde expansion**: Handle both `~` and `~user` if possible, else just `~`

## 7. No-Dependency Constraints

- Use `Deno` APIs for file operations (pi extensions run in Deno)
- Implement glob matching manually (20-30 lines)
- Parse bash commands naively (split on spaces, filter obvious non-paths)
- No external crates/modules - pure TypeScript/Deno standard library

## 8. Test Plan

### 8.1 File Organization

Mirror source structure under `.pi/extensions/pi-gate/tests/`:

```
tests/
├── matcher.test.ts
├── guards.test.ts
├── session.test.ts
├── config.test.ts
├── prompts.test.ts
├── checkFileAccess.test.ts
└── checkBashCommand.test.ts
```

Use Deno's built-in test runner with `spy` and `stub` from `std/testing/mock.ts`.

### 8.2 Matcher Tests

**Happy Path:**
- Exact string match (`ls` matches `ls`)
- Single wildcard `*` matches any chars (`ls *` matches `ls foo.txt`)
- Wildcard at end only (`cat ~/.config/*` matches nested path)
- Wildcard in middle (`file*.txt` matches `file123.txt`)
- Multiple wildcards (`*/*.txt` matches `src/main.txt`)
- `?` single character (`file?.txt` matches `file1.txt`)
- `?` does not match zero chars (`file?.txt` rejects `file.txt`)
- `?` does not match many chars (`file?.txt` rejects `file12.txt`)
- Pattern list matching first in array
- Pattern list matching second in array
- Pattern list no match returns false

**Corner Cases:**
- Pattern with literal dot (not regex wildcard)
- Pattern with dot and wildcard (`*.txt`)
- Empty pattern returns false
- Empty value matches `*`
- Pattern equals value with wildcard (`*` matches `*`)
- Case sensitivity (Unix-style)
- Special regex chars are literal (square brackets)
- Pattern longer than value returns false
- Value longer than pattern returns false

### 8.3 Guards Tests

**Happy Path:**
- Project file classification (path under cwd)
- External file classification (path outside cwd)
- Tilde expansion to home directory
- Relative path resolution with `./`
- Relative path without dot prefix
- Extract simple file arguments from command

**Corner Cases:**
- Parent directory escape (`../../../etc/passwd` becomes external)
- Double slash normalization (`~/.pi//config`)
- Trailing slash on directory
- Current directory redundancy (`./././file`)
- File at cwd boundary (cwd itself is project)
- Symlink resolved outside project becomes external
- Command with flags (flags filtered, paths extracted)
- Command with no paths returns empty array
- Quoted paths with spaces (document expected behavior)
- Environment variables not expanded (literal `$HOME`)

### 8.4 Session Tests

**Happy Path:**
- Approve and check external path
- Approve and check bash pattern
- Multiple externals approved
- Multiple bash patterns approved
- getSessionState returns current state

**Corner Cases:**
- Unapproved external returns false
- Unapproved bash pattern returns false
- Session isolation (fresh session has no approvals)
- Approving same path twice is idempotent
- Approving same pattern twice is idempotent
- Empty session state (fresh sets are empty)

### 8.5 Config Tests

**Happy Path:**
- Load valid config file with all sections
- Load missing config returns empty defaults
- Save and reload roundtrip preserves data
- Append to bashAllow section
- Append to externalAllow section

**Corner Cases (Strict Validation):**
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

### 8.6 Prompts Tests

Use Deno mocking (`spy`, `stub`) for pi's prompt API.

**Happy Path:**
- `promptAllowDeny` returns true when user selects Allow
- `promptAllowDeny` returns false when user selects Deny
- `promptPattern` returns edited value
- `promptPattern` returns null when input cleared
- `promptPattern` returns null on cancel (Escape)
- `confirmAddToConfig` returns true when user selects Yes
- `confirmAddToConfig` returns false when user selects No

**Corner Cases:**
- `promptAllowDeny` message formatting correct
- `promptPattern` suggestion pre-filled in input
- `promptPattern` description appears in label
- `confirmAddToConfig` section name displayed
- `promptPattern` trims whitespace from input
- `promptPattern` empty string after trim returns null

### 8.7 checkFileAccess Tests

Mock: `loadConfig`, `normalizePath`, `classifyPath`, `isExternalApproved`, `promptAllowDeny`, `approveExternal`, `confirmAddToConfig`, `promptPattern`, `saveConfig`.

**Happy Path:**
- Project file allowed with empty deny list
- Project file allowed when not matching deny pattern
- External file allowed when in config externalAllow
- External file allowed when in session approved list
- External file approved by user and persisted to config
- External file approved by user but not persisted (session-only)

**Corner Cases:**
- Project file blocked by exact deny pattern
- Project file blocked by glob deny pattern
- External file denied by user at prompt
- Config loaded only once per call
- Normalization happens before classification

### 8.8 checkBashCommand Tests

Mock: `loadConfig`, `getSessionState`, `matchesGlob`, `promptAllowDeny`, `promptPattern`, `approveBashPattern`, `confirmAddToConfig`, `saveConfig`, `extractPathsFromCommand`, `checkFileAccess`.

**Happy Path:**
- Command allowed by config bashAllow pattern
- Command allowed by session approved pattern
- Command with project files all allowed
- Command with external files all allowed
- No match prompts user, allows, persists, restarts, succeeds
- No match prompts user, allows, skips persist, restarts, succeeds

**Corner Cases:**
- Pattern matches but file access denies (blocked)
- User denies command at prompt (blocked)
- User allows command but clears pattern (blocked)
- Multiple files in command, one denied (whole command blocked)
- Command with no file arguments (automatic pass on file step)
- Tail recursion doesn't cause infinite loop (exactly 2 calls)
- Config loaded once, session loaded once per call
