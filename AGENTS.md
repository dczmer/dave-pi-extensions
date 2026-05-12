# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent. Developed on Nix with Node.js.

## Environment

- **Nix**: Flake-based devShell in `flake.nix`
- **Node.js**: Runtime and test runner for all code
- **Allowed Dependencies**:
  - `@mariozechner/*` - Pi SDK packages
  - `bash-parser` - Accurate parsing of complex bash command strings
  - `@types/node` - Node.js types (dev dependency)
  - `typescript` - TypeScript compiler (dev dependency)
- No other runtime deps; keep dependencies minimal

## Dependencies

Node modules managed at project root only. All extensions use shared dependencies from project `package.json`. No `package.json` in extension directories.

**CRITICAL**: Never install packages automatically.
- If dependency missing, prompt user to install manually at project root
- Wait for confirmation before continuing

## Testing

- Run tests: `npm test` (tests live under `test/extensions/EXTENSION_NAME/`)
- Type check: `npm run typecheck`
- Lint: `npx eslint extensions/`
- **Permission prompts**: If tests fail due permissions, ask user which flags to add

### Test Isolation (CRITICAL)

**Tests must NEVER modify real user configuration files.**

#### Filesystem isolation: tempfs directories

When test code needs to read or write files, create a temporary directory with
`mkdtempSync` and clean it up after the test.  Use a `withTempDir` helper:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("load/save roundtrip", () => {
  withTempDir((dir) => {
    // ... use dir as isolated filesystem root ...
  });
});
```

This is the **primary** fs-isolation pattern.  It uses real `node:fs` so there
are no impedance mismatches with the code under test, and cleanup is automatic.

#### Config module mocking

When testing code that **consumes** a `ConfigResult` (e.g., `checkBashCommand`,
`checkFileAccess`), do not call `loadConfig(cwd)` with temp directories and env
var overrides.  Instead, mock the config module's exports directly with
`t.mock.method`:

```typescript
import * as config from "../../../extensions/pi-gate/config.ts";
import { test } from "node:test";

test("command checked against mocked config", async (t) => {
  const fakeResult: config.ConfigResult = {
    merged:  { bashAllow: ["cat *"], externalAllow: [], projectDeny: [] },
    global:  { bashAllow: [],        externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["cat *"], externalAllow: [], projectDeny: [] },
    globalPath:  "/fake/global.json",
    projectPath: "/fake/project.json",
  };

  t.mock.method(config, "loadConfig", () => fakeResult);
  t.mock.method(config, "saveConfig", () => {});

  // ... test code that calls loadConfig / saveConfig ...
});
```

- **Config module itself** (`config.test.ts`): tests that validate `loadConfig`
  and `saveConfig` behavior should use tempfs directories (above).  They are
  testing the real config module, not consuming it.
- **Consumer modules** (`bash-guard.test.ts`, `file-access.test.ts`): mock
  `loadConfig`/`saveConfig` to return crafted `ConfigResult` objects.  This
  eliminates the need for temp directories and, critically, for `process.env`
  overrides.

#### Environment variable isolation

- **Never write to `process.env`** to redirect config paths or other behavior.
  Use `t.mock.method` on the relevant module instead.
- If a function reads from `process.env` (e.g., `homedir()` from `node:os`),
  mock that specific function with `t.mock.method` — do not mutate the env.
- Mocks scoped to `t` auto-cleanup on test completion.

## Project Structure

`package.json` configures pi to discover resources from these directories:

| Resource | `package.json` field | Dir |
|----------|---------------------|-----|
| Extensions | `pi.extensions` → `["./extensions"]` | `extensions/` |
| Skills | `pi.skills` → `["./skills"]` | `skills/` |
| Prompts | `pi.prompts` → `["./prompts"]` | `prompts/` |
| Themes | `pi.themes` → `["./themes"]` | `themes/` |

```
.
├── extensions/     # Pi extensions (TS) — see placement rules below
├── test/           # Tests — mirror structure: test/extensions/EXTENSION_NAME/
├── themes/         # JSON theme files (*.json)
├── prompts/        # Prompt templates (*.md)
├── skills/         # Pi skills — one subdirectory per skill
├── plans/          # Implementation plans (not a pi resource)
├── flake.nix       # Nix devShell
└── package.json    # Pi package manifest
```

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
    ├── helper.ts           # Additional modules
    └── tsconfig.json       # TypeScript config (uses project node_modules)
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

### Theme Placement

```
themes/
└── my-theme.json           # Theme file (JSON, pi theme format)
```

### Prompt Placement

```
prompts/
└── my-template.md          # Prompt template (markdown)
```

### Skill Placement

```
skills/
└── my-skill/
    └── SKILL.md            # Skill definition (Agent Skills standard)
```

## Package Manifest

`package.json` defines pi package with `pi` field:
- `extensions`: paths to extension dirs (pi auto-discovers `*.ts` and `*/index.ts`)
- `skills`: paths to skill dirs (pi discovers `*/SKILL.md`)
- `prompts`: paths to prompt dirs (pi discovers `*.md`)
- `themes`: paths to theme dirs (pi discovers `*.json`)

## Development Workflow

1. Edit code
2. Add tests
3. Run verification commands in order:
   - `npm test` — run all tests
   - `npm run typecheck` — type check
   - `npx eslint extensions/` — lint
4. Fix issues, repeat until clean
5. Only then consider work complete

## Documentation

### JSDoc Comments

All exported functions and interfaces must carry TSDoc/JSDoc comments.

- **Summary**: Single-sentence description on the first line.
- **Description**: Blank line, then one or more paragraphs explaining behavior, side effects, and context.
- **`@param`**: Every parameter documented with name, type, and purpose.
- **`@returns`**: Return value documented with type and meaning.
- **`@deprecated`**: Use on legacy functions; reference the replacement via `{@link ...}`.

```typescript
/**
 * Load global and project pi-gate configs, merge them, and return the
 * combined result.  Project config lives at `{cwd}/.pi/extensions/pi-gate.json`;
 * global config at the standard agent extensions path (overridable via
 * `PI_GATE_GLOBAL_CONFIG_PATH`).
 *
 * @param cwd - Project working directory used to locate the project config.
 * @returns Merged configuration along with the raw global and project configs
 *          and their filesystem paths.
 */
export function loadConfig(cwd: string): ConfigResult { ... }
```

- Interfaces exported from a module get a descriptive one-liner:

```typescript
/** Access control configuration for pi-gate. */
export interface PiGateConfig { ... }
```

- Keep existing comments when they already follow this style; enhance sparse ones.
- No empty JSDoc blocks — every `@param` and `@returns` tag must carry text.

## Constraints Checklist

- [ ] Only Node.js built-ins (`node:*`), `@mariozechner/*`, and `bash-parser` imports at runtime
- [ ] Dev dependencies (`typescript`, `@types/node`) allowed with manual install
- [ ] Tests use `node:test` and `node:assert`
- [ ] Project `package.json` and extension `tsconfig.json` present
- [ ] All verification commands pass before finishing
