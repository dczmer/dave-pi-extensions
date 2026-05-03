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

```
.
├── extensions/     # Pi extensions (TS)
├── themes/         # JSON theme files
├── prompts/        # Prompt templates
├── skills/         # Pi skills
├── deno.jsonc      # Deno config + imports
├── flake.nix       # Nix devShell
└── package.json    # Pi package manifest
```

## Package Manifest

`package.json` defines pi package with `pi` field:
- `extensions`: paths to extension dirs
- `skills`: paths to skill dirs  
- `prompts`: paths to prompt dirs
- `themes`: paths to theme dirs

## Development Workflow

1. Edit code
2. Add tests
3. Run `deno task test` (or `deno test` with explicit perms)
4. Fix issues, repeat

## Constraints Checklist

- [ ] Only `@std` and `@mariozechner` imports
- [ ] No `--allow-all` in tests
- [ ] Prompt before installing deps
- [ ] Test task defined in `deno.jsonc`
