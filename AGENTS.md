# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent. Developed on Nix with Node.js.

## Environment

- **Nix**: Flake-based devShell in `flake.nix`
- **Node.js**: Runtime and test runner for all code
- **Runtime / Peer Dependencies**:
  - `@mariozechner/pi` — Pi SDK peer dependency
  - `@mariozechner/pi-coding-agent` — Pi coding agent peer dependency
  - `bash-parser` — Runtime dependency for accurate parsing of complex bash command strings
- **Dev Dependencies**:
  - `@types/node` — Node.js types
  - `typescript` — TypeScript compiler
  - `@eslint/js`, `eslint`, `prettier`, `typescript-eslint`, `typescript-language-server` — Linting and formatting
- No other runtime deps; keep dependencies minimal

## Dependencies

Node modules managed at project root only. All extensions use shared dependencies from project `package.json`. No `package.json` in extension directories.

**CRITICAL**: Never install packages automatically.

- If dependency missing, prompt user to install manually at project root
- Wait for confirmation before continuing

## Testing

- Run tests: `npm test` (tests live under `test/extensions/EXTENSION_NAME/`)
- Type check: `npm run typecheck`
- Lint: `npx eslint .`
- **Permission prompts**: If tests fail due permissions, ask user which flags to add

### Test Isolation (CRITICAL)

**Tests must NEVER modify real user configuration files.**

#### Filesystem isolation: tempfs directories

When test code needs to read or write files, create a temporary directory with
`mkdtempSync` and clean it up after the test. Use a `withTempDir` helper:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('load/save roundtrip', () => {
  withTempDir((dir) => {
    // ... use dir as isolated filesystem root ...
  });
});
```

This is the **primary** fs-isolation pattern. It uses real `node:fs` so there
are no impedance mismatches with the code under test, and cleanup is automatic.

#### Config module mocking

When testing code that **consumes** a `ConfigResult` (e.g., `checkBashCommand`,
`checkFileAccess`), do not call `loadConfig(cwd)` with temp directories and env
var overrides. Instead, build a fake `ConfigResult` with a helper and pass it
directly to the function under test:

```typescript
import { type ConfigResult } from '../../../extensions/pi-gate/config.ts';

function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const empty = () => ({
    bashAllow: [] as string[],
    externalAllow: [] as string[],
  });
  return {
    merged: { ...empty(), ...(overrides?.merged || {}) },
    global: { ...empty(), ...(overrides?.global || {}) },
    project: { ...empty(), ...(overrides?.project || {}) },
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    ...overrides,
  };
}

// ... inside a test:
const configResult = createConfigResult({ merged: { bashAllow: ['cat *'] } });
const allowed = await checkBashCommand('cat file.txt', cwd, configResult, ctx);
```

- **Config module itself** (`config.test.ts`): tests that validate `loadConfig`
  and `saveConfig` behavior should use tempfs directories (above). They are
  testing the real config module, not consuming it.
- **Consumer modules** (`bash-guard.test.ts`, `file-access.test.ts`): craft
  `ConfigResult` objects with a helper and pass them directly to the function
  under test. This eliminates the need for temp directories and, critically,
  for `process.env` overrides.

#### Environment variable isolation

- **Never write to `process.env`** to redirect config paths or other behavior.
  Use `t.mock.method` on the relevant module instead.
- If a function reads from `process.env` (e.g., `homedir()` from `node:os`),
  mock that specific function with `t.mock.method` — do not mutate the env.
- Mocks scoped to `t` auto-cleanup on test completion.

## Project Structure

`package.json` configures pi to discover resources from these directories:

| Resource   | `package.json` field                 | Dir           |
| ---------- | ------------------------------------ | ------------- |
| Extensions | `pi.extensions` → `["./extensions"]` | `extensions/` |
| Skills     | `pi.skills` → `["./skills"]`         | `skills/`     |
| Prompts    | `pi.prompts` → `["./prompts"]`       | `prompts/`    |
| Themes     | `pi.themes` → `["./themes"]`         | `themes/`     |

```
.
├── extensions/     # Pi extensions (TS) — see placement rules below
├── test/           # Tests — mirror structure: test/extensions/EXTENSION_NAME/
├── themes/         # JSON theme files (*.json)
├── prompts/        # Prompt templates (*.md)
├── skills/         # Pi skills — one subdirectory per skill
├── src/            # Shared source code and type declarations
├── plans/          # Implementation plans (not a pi resource)
├── flake.nix       # Nix devShell
└── package.json    # Pi package manifest
```

`skills/` and `prompts/` may be empty or absent when unused.

### Extension Placement

Pi auto-discovers TypeScript extensions in `extensions/`:

**Single-file extensions** — for simple, one-module extensions:

```
extensions/
└── my-extension.ts         # exports default function(pi: ExtensionAPI)
```

**Directory extensions** — for multi-file extensions:

```
extensions/
└── my-extension/
    ├── index.ts            # Entry point (exports default function)
    └── helper.ts           # Additional modules
```

- Entry point must be `index.ts` inside extension directory
- Sub-modules imported with relative paths
- No `package.json` in extension — uses project root dependencies
- Do NOT use `.pi/extensions/` — that's for project-local overrides, not package resources

### Test Placement

Tests live outside `extensions/` so pi never mistakes them for extensions:

```
test/
└── extensions/
    └── my-extension/       # Tests for extensions/my-extension/
        └── *.test.ts
```

- Mirror extension path: `test/extensions/my-extension/`
- Import source with `../../../extensions/my-extension/foo.ts`
- Run with `node --test test/**/*.test.ts`

## Development Workflow

1. Edit code
2. Add tests
3. Run verification commands in order:
   - `npm test` — run all tests
   - `npm run typecheck` — type check
   - `npx eslint .` — lint
   - `npm run format:check` — check formatting
   - `mdl README.md docs/**/*.md` — lint markdown docs (only when these files change)
4. Fix issues, repeat until clean
5. Only then consider work complete

### Markdown Linting (mdl)

Project uses [mdl](https://github.com/markdownlint/markdownlint) with custom style in `.mdl_style.rb`.

Key rules affecting editing:

- **MD004 `:sublist`** — unordered lists may use different bullet characters (`-`, `*`, `+`) at different nesting levels. Matches bullets.vim behavior.
- **MD007 `indent 4`** — nested list items need 4 spaces. Ensure vim `shiftwidth=4` in markdown buffers.
- **MD029 `"one"`** — ordered lists use lazy numbering (`1. 1. 1.`). bullets.vim auto-increments during editing; run `mdl -w README.md docs/**/*.md` to normalize before committing.
- **MD013** disabled — long URLs and fenced code blocks do not need wrapping.

When changing `README.md` or any file under `docs/`, run:

```bash
mdl README.md docs/**/*.md
```

Auto-fix ordered list numbering with:

```bash
mdl -w README.md docs/**/*.md
```

## Documentation

### JSDoc Comments

All exported functions and interfaces must carry TSDoc/JSDoc comments.

- Interfaces exported from a module get a descriptive one-liner:

```typescript
/** Access control configuration for pi-gate. */
export interface PiGateConfig { ... }
```

- Keep existing comments when they already follow this style; enhance sparse ones.
- No empty JSDoc blocks — every `@param` and `@returns` tag must carry text.

## Constraints Checklist

- [x] Only Node.js built-ins (`node:*`), `@mariozechner/*`, and `bash-parser` imports at runtime
- [x] Dev dependencies (`typescript`, `@types/node`) allowed with manual install
- [x] Tests use `node:test` and `node:assert`
- [x] Project `package.json` and root `tsconfig.json` present
- [x] Prettier config (`.prettierrc.json`) and ignore (`.prettierignore`) present
- [x] All verification commands pass before finishing
