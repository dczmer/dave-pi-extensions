# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent.

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

### Test Isolation (CRITICAL)

**Tests must NEVER modify real user configuration files.**

#### Filesystem isolation: tempfs directories

When test code needs to read or write files, create a temporary directory with
`mkdtempSync` and clean it up after the test. Use the `withTempDir` helper.

This is the **primary** fs-isolation pattern. It uses real `node:fs` so there
are no impedance mismatches with the code under test, and cleanup is automatic.

#### Config module mocking

When testing code that **consumes** a `ConfigResult` (e.g., `checkBashCommand`,
`checkFileAccess`), do not call `loadConfig(cwd)` with temp directories and env
var overrides. Instead, build a fake `ConfigResult` with the
`createConfigResult` helper and pass it directly to the function under test.

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

Project layout:
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

`package.json` configures pi to discover resources from the directories in this repository.

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

## Test Commands

- `npm test` — run all tests
- `npm run typecheck` — type check
- `npx eslint .` — lint
- `npm run format:check` — check formatting
- `mdl README.md docs/**/*.md` — lint markdown docs (only when these files change)

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
