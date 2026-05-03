# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent. Developed on Nix with Deno.

## Environment

- **Nix**: Flake-based devShell in `flake.nix`
- **Deno**: Runtime and test runner (for project-level scripts)
- **Node.js**: Runtime for Pi extensions (Pi loads extensions via Node.js/jiti)
- **Allowed Dependencies**:
  - `@std/*` - Deno standard library (Deno scripts only)
  - `@mariozechner/*` - Pi SDK packages
  - `@types/node` - Node.js types (extensions only, dev dependency)
  - `typescript` - TypeScript compiler (extensions only, dev dependency)
- **No external deps** ever

## Testing

- Run tests: `deno test` for Deno-based code (no `--allow-all`)
- Run Node.js extension tests: `cd extensions/<name> && npm test`
- Use `deno.jsonc` tasks section for full test command
- **Permission prompts**: If tests fail due to permissions, ask user which flags to add (`--allow-read`, `--allow-env`, etc.)
- Maintain `test` task in `deno.jsonc` with all of the approved permissions flags.

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
├── deno.jsonc      # Deno config + imports
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
    ├── tsconfig.json       # TypeScript config (Node.js extensions)
    └── tests/              # Tests (Node.js test runner for extensions)
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
   - For Deno code: `deno task test` — unit tests
   - For Node.js extensions: `cd extensions/<name> && npm test`
   - `deno lint extensions/<name>/` — linter (Deno code only)
   - `deno check extensions/<name>/index.ts` — type checker (Deno code only)
   - For Node.js extensions: `cd extensions/<name> && npx tsc --noEmit`
4. Fix issues, repeat all three until clean
5. Only then consider work complete

## Constraints Checklist

### Deno Code
- [ ] Only `@std` and `@mariozechner` imports
- [ ] No `--allow-all` in tests
- [ ] Prompt before installing deps
- [ ] Test task defined in `deno.jsonc`

### Node.js Extensions (e.g., pi-gate)
- [ ] Only Node.js built-ins (`node:*`) and `@mariozechner/*` imports at runtime
- [ ] Dev dependencies (`typescript`, `@types/node`) allowed with manual install
- [ ] Tests use `node:test` and `node:assert`
- [ ] `package.json` and `tsconfig.json` present
- [ ] All verification commands pass before finishing
