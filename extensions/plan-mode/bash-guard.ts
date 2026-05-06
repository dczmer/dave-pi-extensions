/**
 * Bash command guard for plan mode.
 *
 * Parses bash commands with bash-parser to produce an AST,
 * then walks the AST to detect destructive operations:
 * - Commands that always modify/delete/install
 * - Write redirects (>, >>, >|, &>, etc.) to real files
 * - git/nix subcommands that modify state
 *
 * Returns null if command appears safe, or a blocking reason string.
 */

import { createRequire } from "node:module";

// bash-parser is a CJS module with no type declarations.
// Use createRequire to load it without TypeScript errors.
const require = createRequire(import.meta.url);
const parse: (code: string, opts?: { mode?: string }) => unknown =
  require("bash-parser");

// ── AST types (partial, what we need) ──────────────────────────

interface WordNode {
  type: "Word";
  text: string;
}

interface RedirectNode {
  type: "Redirect";
  op: { type: string; text: string };
  file: WordNode;
}

interface CommandNode {
  type: "Command";
  name?: { text: string };
  suffix?: Array<WordNode | RedirectNode>;
}

// ── Destructive commands (always block) ───────────────────────

const DESTRUCTIVE_COMMANDS = new Set([
  // File deletion
  "rm", "rmdir", "unlink", "shred",
  // File modification / creation
  "mv", "cp", "mkdir", "touch", "ln", "install", "dd", "truncate",
  "rename",
  // Permissions
  "chmod", "chown", "chgrp", "chattr",
  // Mount / swap
  "mount", "umount", "losetup", "swapon", "swapoff",
  // Users / groups
  "useradd", "usermod", "userdel", "groupadd", "groupmod", "groupdel", "passwd",
  // Services / system
  "systemctl", "service",
  // Process termination
  "kill", "killall", "pkill", "reboot", "shutdown", "poweroff", "halt",
  // Scheduling
  "crontab", "at", "batch",
  // Package managers
  "npm", "npx", "yarn", "pnpm",
  "pip", "pip3",
  "gem", "bundle", "cargo", "rustup",
  "brew",
  "apt", "apt-get", "dpkg", "yum", "dnf", "rpm", "pacman", "emerge", "zypper",
  "nix-env", "nixos-rebuild", "snap", "flatpak",
  // Container / VM
  "docker", "podman", "kubectl", "helm",
  // Downloaders (always write files)
  "wget",
  // Editors
  "vim", "vi", "nvim", "nano", "emacs", "code", "subl", "gedit",
  // Remote copy
  "scp", "rsync", "sftp",
  // Archive creation
  "zip", "tar", "gzip", "bzip2", "xz", "7z", "compress",
  // IaC
  "terraform", "pulumi",
  // GitHub / GitLab CLIs
  "gh", "glab",
  // Build tools / compilers
  "make", "cmake", "gcc", "g++", "clang", "clang++",
  // Always writes to files
  "tee",
]);

// ── Git read-only subcommands ──────────────────────────────────

const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "branch", "tag", "remote",
  "stash", // only "list" is safe but we check that inline
  "grep", "blame",
  "ls-files", "ls-tree", "ls-remote",
  "rev-parse", "rev-list", "describe", "config",
  "fetch", "shortlog", "reflog", "help", "version", "whatchanged",
]);

// ── Nix read-only subcommands ─────────────────────────────────

const NIX_READONLY = new Set([
  "eval", "flake", "store", "show-config", "repl", "search",
  "derivation", "path-info", "hash", "why-depends",
]);

// ── Write redirect operator types ──────────────────────────────

const WRITE_REDIRECTS = new Set([
  "great",       // >
  "dgreat",      // >>
  "greatand",    // >&
  "clobber",     // >|
  "lessgreat",   // <>
]);

// ── Public API ─────────────────────────────────────────────────

/** Returns null if command is safe, or a blocking reason string. */
export function isDestructiveCommand(command: string): string | null {
  let ast: unknown;
  try {
    ast = parse(command, { mode: "posix" });
  } catch {
    return "Blocked: failed to parse command in plan mode";
  }

  return walk(ast);
}

// ── AST walker ─────────────────────────────────────────────────

function walk(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node !== "object") return null;

  const obj = node as Record<string, unknown>;

  // Check Command nodes
  if (obj.type === "Command") {
    const result = checkCommand(obj as unknown as CommandNode);
    if (result) return result;
  }

  // Recurse into arrays and objects
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = walk(item);
        if (result) return result;
      }
    } else if (typeof value === "object" && value !== null) {
      const result = walk(value);
      if (result) return result;
    }
  }

  return null;
}

// ── Command checker ────────────────────────────────────────────

function checkCommand(node: CommandNode): string | null {
  // Check write redirects (allow /dev/null)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === "Redirect") {
        const r = item as RedirectNode;
        if (WRITE_REDIRECTS.has(r.op.type)) {
          if (isSafeRedirectTarget(r.file)) continue;
          return `Blocked: write redirect '${r.op.text} ${r.file.text}' may modify files`;
        }
      }
    }
  }

  // No command name → nothing to check (e.g. assignment-only)
  if (!node.name) return null;

  const cmdName = node.name.text;
  const firstArg = getFirstArg(node);

  // Always-block destructive commands
  if (DESTRUCTIVE_COMMANDS.has(cmdName)) {
    return `Blocked: '${cmdName}' can modify the system`;
  }

  // git: check subcommand
  if (cmdName === "git" && firstArg) {
    // "git stash" is only safe with "list"
    if (firstArg === "stash") {
      const secondArg = getNthArg(node, 2);
      if (secondArg !== "list") {
        return "Blocked: git stash may modify state";
      }
    } else if (!GIT_READONLY.has(firstArg)) {
      return `Blocked: git ${firstArg} may modify the repository`;
    }
  }

  // nix: check subcommand + sub-subcommand
  if (cmdName === "nix" && firstArg) {
    if (firstArg === "flake") {
      const secondArg = getNthArg(node, 2);
      const allowed = new Set(["show", "metadata", "check"]);
      if (!secondArg || !allowed.has(secondArg)) {
        return `Blocked: nix flake ${secondArg ?? ""} may modify the system`;
      }
    } else if (firstArg === "store") {
      const secondArg = getNthArg(node, 2);
      const allowed = new Set(["cat", "ls", "path-info"]);
      if (!secondArg || !allowed.has(secondArg)) {
        return `Blocked: nix store ${secondArg ?? ""} may modify the system`;
      }
    } else if (firstArg === "derivation") {
      const secondArg = getNthArg(node, 2);
      if (secondArg && secondArg !== "show") {
        return `Blocked: nix derivation ${secondArg} may modify the system`;
      }
    } else if (!NIX_READONLY.has(firstArg)) {
      return `Blocked: nix ${firstArg} may modify the system`;
    }
  }

  // curl: block if -o / -O / --output is present
  if (cmdName === "curl") {
    if (node.suffix) {
      for (const item of node.suffix) {
        if (item.type === "Word") {
          const w = item as WordNode;
          if (w.text === "-o" || w.text === "-O" || w.text === "--output") {
            return "Blocked: curl output flag may write files";
          }
        }
      }
    }
  }

  return null;
}

// ── Argument helpers ───────────────────────────────────────────

/** Return true if redirect target is safe (/dev/null or numeric fd). */
function isSafeRedirectTarget(file: WordNode): boolean {
  if (file.text === "/dev/null") return true;
  // Numeric file descriptors (e.g. 2>&1, 1>&2) and dash (close fd)
  if (/^[0-9]+$/.test(file.text) || file.text === "-") return true;
  return false;
}

/** Extract the first non-redirect argument (index 0 after command name). */
function getFirstArg(node: CommandNode): string | undefined {
  if (!node.suffix) return undefined;
  for (const item of node.suffix) {
    if (item.type === "Word") return (item as WordNode).text;
    // Skip redirects when looking for subcommand
  }
  return undefined;
}

/** Extract the n-th Word argument (1-indexed, skipping redirects). */
function getNthArg(node: CommandNode, n: number): string | undefined {
  if (!node.suffix) return undefined;
  let count = 0;
  for (const item of node.suffix) {
    if (item.type === "Word") {
      count++;
      if (count === n) return (item as WordNode).text;
    }
  }
  return undefined;
}
