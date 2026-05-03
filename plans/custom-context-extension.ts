/**
 * Custom Context Extension for pi
 *
 * Purpose:
 * This extension enables managing pi configuration and resources (skills, prompts,
 * themes, and context files) as a Nix package. Because Nix packages are installed
 * into immutable, hash-based directories under /nix/store (e.g., /nix/store/abc123...),
 * we cannot hardcode absolute paths or rely on standard locations like ~/.pi/agent/.
 *
 * Instead, this extension reads the PI_CUSTOM_DIR environment variable at runtime
 * to discover resources from the Nix store path where the pi configuration package
 * is installed.
 *
 * Note on Extensions:
 * Extensions cannot be loaded via PI_CUSTOM_DIR because pi discovers extensions
 * at startup before the resources_discover event fires. This is intentional - it
 * allows this very extension (placed in .pi/extensions/ or ~/.pi/agent/extensions/)
 * to run and set up the rest of the resources.
 *
 * To manage core extensions via Nix while keeping user extensions in ~/.pi:
 *
 * 1. Symlink approach (recommended with home-manager):
 *    ```nix
 *    home.activation.piExtensions = lib.hm.dag.entryAfter ["writeBoundary"] ''
 *      mkdir -p ~/.pi/agent/extensions
 *      ln -sf ${piExtensionsPackage}/extensions/*.ts ~/.pi/agent/extensions/
 *    '';
 *    ```
 *
 * 2. Wrapper script with -e flags:
 *    ```nix
 *    wrapProgram $out/bin/pi \
 *      --add-flags "-e ${piExtensionsPackage}/extensions/ext1.ts" \
 *      --add-flags "-e ${piExtensionsPackage}/extensions/ext2.ts"
 *    ```
 *
 * 3. Fixed symlink in home directory:
 *    ```nix
 *    home.file.".pi/agent/nix-extensions".source = piExtensionsPackage;
 *    ```
 *    Then add "~/.pi/agent/nix-extensions/extensions/*.ts" to settings.json
 *
 * Note on Settings:
 * Pi's settings.json does not support includes or merging from multiple files.
 * For Nix flakes (non-home-manager installs), use a wrapper script that merges
 * Nix-managed settings with user settings at runtime:
 *
 * ```nix
 * pi-wrapped = pkgs.writeShellScriptBin "pi" ''
 *   export PI_AUTH_DIR="''${HOME}/.pi/agent"
 *   export MERGED_CONFIG=$(mktemp -d)
 *
 *   # Merge Nix store base + user settings
 *   ${pkgs.jq}/bin/jq -s '.[0] * .[1]' \
 *     ${piBaseSettings}/settings.json \
 *     "''${PI_AUTH_DIR}/settings.json" 2>/dev/null \
 *     > "$MERGED_CONFIG/settings.json"
 *
 *   # Copy auth to temp dir so pi finds it
 *   mkdir -p "$MERGED_CONFIG"
 *   ln -sf "''${PI_AUTH_DIR}/auth.json" "$MERGED_CONFIG/auth.json" 2>/dev/null || true
 *
 *   export PI_CODING_AGENT_DIR="$MERGED_CONFIG"
 *   ${pi-package}/bin/pi "$@"
 * '';
 * ```
 *
 * Expected directory structure at PI_CUSTOM_DIR:
 *   ├── AGENTS.md          # Injected as hidden message to LLM
 *   ├── APPEND_SYSTEM.md   # Appended to system prompt (like built-in behavior)
 *   ├── skills/            # Additional skill directories
 *   ├── prompts/           # Additional prompt template directories
 *   └── themes/            # Additional theme directories
 *
 * Usage in a Nix derivation:
 *   wrapProgram $out/bin/pi \
 *     --set PI_CUSTOM_DIR "${piConfigPackage}" \
 *     --add-flags "-e ${piExtensionsPackage}/extensions/custom-context-extension.ts"
 *
 * Where piConfigPackage contains the above structure.
 *
 * Bottom Line:
 * This extension handles PI_CUSTOM_DIR for resources (skills/prompts/themes/context).
 * For extensions and settings merging in a Nix flake, use Option 2 (wrapper script)
 * that sets PI_CODING_AGENT_DIR to a temp dir with merged settings and symlinks auth.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const baseDir = process.env.PI_CUSTOM_DIR;
  if (!baseDir) return;

  pi.on("resources_discover", async (_event, _ctx) => ({
    skillPaths: existsSync(join(baseDir, "skills")) ? [join(baseDir, "skills")] : [],
    promptPaths: existsSync(join(baseDir, "prompts")) ? [join(baseDir, "prompts")] : [],
    themePaths: existsSync(join(baseDir, "themes")) ? [join(baseDir, "themes")] : [],
  }));

  pi.on("before_agent_start", async (event, _ctx) => {
    const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } = {};

    const appendSystem = join(baseDir, "APPEND_SYSTEM.md");
    if (existsSync(appendSystem)) {
      result.systemPrompt = event.systemPrompt + "\n\n" + await readFile(appendSystem, "utf-8");
    }

    const agents = join(baseDir, "AGENTS.md");
    if (existsSync(agents)) {
      result.message = {
        customType: "custom-agents",
        content: await readFile(agents, "utf-8"),
        display: false,
      };
    }

    return result;
  });
}
