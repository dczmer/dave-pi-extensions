# Agent Instructions

## Project Overview

Pi package bundling extensions, themes, prompts for pi coding agent. Developed on Nix with Deno.

## Environment

- **Nix**: Flake-based devShell in `flake.nix`
- **Deno**: Runtime and test runner
- **Allowed Dependencies**:
  - `@std/*` - Deno standard library
  - `@mariozechner/*` - Pi SDK packages
- **No external deps** ever

## Testing

- Run tests: `deno test` (no `--allow-all`)
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
    └── tests/              # Tests (Deno test runner)
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
   - `deno task test` — unit tests
   - `deno lint extensions/<name>/` — linter
   - `deno check extensions/<name>/index.ts` — type checker
4. Fix issues, repeat all three until clean
5. Only then consider work complete

## Constraints Checklist

- [ ] Only `@std` and `@mariozechner` imports
- [ ] No `--allow-all` in tests
- [ ] Prompt before installing deps
- [ ] Test task defined in `deno.jsonc`
- [ ] All three verification commands pass before finishing
