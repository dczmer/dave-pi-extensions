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

## Testing

- Run tests: `npm test` or `cd extensions/<name> && npm test`
- **Permission prompts**: If tests fail due to permissions, ask user which flags to add

## Dependencies

**CRITICAL**: Never install packages automatically.
- If dependency missing, prompt user to install manually
- Wait for confirmation before continuing

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
    ├── package.json        # Node.js dependencies (if needed)
    ├── tsconfig.json       # TypeScript config
    └── tests/              # Tests (Node.js test runner)
        └── *.test.ts
```

- Entry point must be `index.ts` inside the extension directory
- Sub-modules can be imported with relative paths
- Tests live inside the extension directory under `tests/`
- Do NOT use `.pi/extensions/` — that's for project-local overrides, not package resources

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
   - `npm test` — run project tests
   - `cd extensions/<name> && npm test` — extension tests
   - `npx tsc --noEmit` — type check
4. Fix issues, repeat until clean
5. Only then consider work complete

## Constraints Checklist

- [ ] Only Node.js built-ins (`node:*`) and `@mariozechner/*` imports at runtime
- [ ] Dev dependencies (`typescript`, `@types/node`) allowed with manual install
- [ ] Tests use `node:test` and `node:assert`
- [ ] `package.json` and `tsconfig.json` present
- [ ] All verification commands pass before finishing
