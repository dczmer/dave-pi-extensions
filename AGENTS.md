# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent. Developed on Nix with Node.js.

## Environment

- **Nix**: Flake-based devShell in `flake.nix`
- **Node.js**: Runtime and test runner for all code
- **Allowed Dependencies**:
  - `@mariozechner/*` - Pi SDK packages
  - `@types/node` - Node.js types (dev dependency)
  - `typescript` - TypeScript compiler (dev dependency)
- **No external deps** ever

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

When testing features that persist to user directories (e.g., `~/.pi/agent/extensions/`):
- Use environment variables to override config paths to temp directories
- Use `process.env.MY_EXTENSION_CONFIG_PATH` pattern in code
- Wrap test operations in `try/finally` to clean up env vars
- Verify isolation by checking the real config file is untouched after tests

**Example pattern:**
```typescript
// In implementation
const configPath = process.env.MY_EXTENSION_CONFIG_PATH ?? 
  join(homedir(), ".pi", "agent", "extensions", "my-ext.json");

// In tests
const tempConfigPath = join(tempDir, "test-config.json");
process.env.MY_EXTENSION_CONFIG_PATH = tempConfigPath;
try {
  // run test
} finally {
  delete process.env.MY_EXTENSION_CONFIG_PATH;
}
```

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

## Constraints Checklist

- [ ] Only Node.js built-ins (`node:*`) and `@mariozechner/*` imports at runtime
- [ ] Dev dependencies (`typescript`, `@types/node`) allowed with manual install
- [ ] Tests use `node:test` and `node:assert`
- [ ] Project `package.json` and extension `tsconfig.json` present
- [ ] All verification commands pass before finishing
