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

import { parseBashCommand, walkCommands } from '../../src/bash-parser.ts';
import type { AstCommand, AstWord, AstRedirect } from '../../src/bash-parser.ts';
import { isUnderArtifactDir } from './plan-artifact.ts';

// ── Destructive commands (always block) ───────────────────────

const DESTRUCTIVE_COMMANDS = new Set([
  // File deletion
  'rm',
  'rmdir',
  'unlink',
  'shred',
  // File modification / creation
  'mv',
  'cp',
  'touch',
  'ln',
  'install',
  'dd',
  'truncate',
  'rename',
  // Permissions
  'chmod',
  'chown',
  'chgrp',
  'chattr',
  // Mount / swap
  'mount',
  'umount',
  'losetup',
  'swapon',
  'swapoff',
  // Users / groups
  'useradd',
  'usermod',
  'userdel',
  'groupadd',
  'groupmod',
  'groupdel',
  'passwd',
  // Services / system
  'systemctl',
  'service',
  // Process termination
  'kill',
  'killall',
  'pkill',
  'reboot',
  'shutdown',
  'poweroff',
  'halt',
  // Scheduling
  'crontab',
  'at',
  'batch',
  // Package managers
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'pip',
  'pip3',
  'gem',
  'bundle',
  'cargo',
  'rustup',
  'brew',
  'apt',
  'apt-get',
  'dpkg',
  'yum',
  'dnf',
  'rpm',
  'pacman',
  'emerge',
  'zypper',
  'nix-env',
  'nixos-rebuild',
  'snap',
  'flatpak',
  // Container / VM
  'docker',
  'podman',
  'kubectl',
  'helm',
  // Downloaders (always write files)
  'wget',
  // Editors
  'vim',
  'vi',
  'nvim',
  'nano',
  'emacs',
  'code',
  'subl',
  'gedit',
  // Remote copy
  'scp',
  'rsync',
  'sftp',
  // Archive creation
  'zip',
  'tar',
  'gzip',
  'bzip2',
  'xz',
  '7z',
  'compress',
  // IaC
  'terraform',
  'pulumi',
  // GitHub / GitLab CLIs
  'gh',
  'glab',
  // Build tools / compilers
  'make',
  'cmake',
  'gcc',
  'g++',
  'clang',
  'clang++',
  // Always writes to files
  'tee',
]);

// ── Git read-only subcommands ──────────────────────────────────

const GIT_READONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'tag',
  'remote',
  'stash', // only "list" is safe but we check that inline
  'grep',
  'blame',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'describe',
  'config',
  'fetch',
  'shortlog',
  'reflog',
  'help',
  'version',
  'whatchanged',
]);

// ── Nix read-only subcommands ─────────────────────────────────

const NIX_READONLY = new Set([
  'eval',
  'flake',
  'store',
  'show-config',
  'repl',
  'search',
  'derivation',
  'path-info',
  'hash',
  'why-depends',
]);

// ── Write redirect operator types ──────────────────────────────

const WRITE_REDIRECTS = new Set([
  'great', // >
  'dgreat', // >>
  'greatand', // >&
  'clobber', // >|
  'lessgreat', // <>
]);

// ── Public API ─────────────────────────────────────────────────

/**
 * Analyze a shell command and decide if it is destructive.
 *
 * Parses the command with bash-parser to build an AST, then walks every
 * command node checking for:
 * - Hard-blocked command names (rm, npm, docker, etc.)
 * - Write redirects (>, >>, >|) to real files (not /dev/null or fds)
 * - git/nix subcommands that mutate state
 * - curl output flags (-o, -O, --output)
 *
 * @param command - The raw shell command string to inspect.
 * @param cwd - Current working directory for path-aware exceptions.
 * @returns `null` if the command is safe, otherwise a human-readable
 *          reason string explaining why it was blocked.
 */
export function isDestructiveCommand(command: string, cwd?: string): string | null {
  let ast;
  try {
    ast = parseBashCommand(command);
  } catch {
    return 'Blocked: failed to parse command in plan mode';
  }

  let reason: string | null = null;

  walkCommands(ast, (cmd) => {
    if (reason) return; // short-circuit after first block
    reason = checkCommand(cmd, cwd);
  });

  return reason;
}

// ── Command checker ────────────────────────────────────────────

function checkCommand(node: AstCommand, cwd?: string): string | null {
  // Check write redirects (allow /dev/null)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === 'Redirect') {
        const r = item as AstRedirect;
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

  // mkdir: allow only under artifact directory
  if (cmdName === 'mkdir') {
    if (cwd) {
      const dirs = getDirArgs(node);
      if (dirs.length > 0 && dirs.every((d) => isUnderArtifactDir(d, cwd))) {
        return null;
      }
    }
    return "Blocked: 'mkdir' can modify the system";
  }

  // Always-block destructive commands
  if (DESTRUCTIVE_COMMANDS.has(cmdName)) {
    return `Blocked: '${cmdName}' can modify the system`;
  }

  // git: check subcommand
  if (cmdName === 'git' && firstArg) {
    // "git stash" is only safe with "list"
    if (firstArg === 'stash') {
      const secondArg = getNthArg(node, 2);
      if (secondArg !== 'list') {
        return 'Blocked: git stash may modify state';
      }
    } else if (!GIT_READONLY.has(firstArg)) {
      return `Blocked: git ${firstArg} may modify the repository`;
    }
  }

  // nix: check subcommand + sub-subcommand
  if (cmdName === 'nix' && firstArg) {
    if (firstArg === 'flake') {
      const secondArg = getNthArg(node, 2);
      const allowed = new Set(['show', 'metadata', 'check']);
      if (!secondArg || !allowed.has(secondArg)) {
        return `Blocked: nix flake ${secondArg ?? ''} may modify the system`;
      }
    } else if (firstArg === 'store') {
      const secondArg = getNthArg(node, 2);
      const allowed = new Set(['cat', 'ls', 'path-info']);
      if (!secondArg || !allowed.has(secondArg)) {
        return `Blocked: nix store ${secondArg ?? ''} may modify the system`;
      }
    } else if (firstArg === 'derivation') {
      const secondArg = getNthArg(node, 2);
      if (secondArg && secondArg !== 'show') {
        return `Blocked: nix derivation ${secondArg} may modify the system`;
      }
    } else if (!NIX_READONLY.has(firstArg)) {
      return `Blocked: nix ${firstArg} may modify the system`;
    }
  }

  // curl: block if -o / -O / --output is present
  if (cmdName === 'curl') {
    if (node.suffix) {
      for (const item of node.suffix) {
        if (item.type === 'Word') {
          const w = item as AstWord;
          if (w.text === '-o' || w.text === '-O' || w.text === '--output') {
            return 'Blocked: curl output flag may write files';
          }
        }
      }
    }
  }

  return null;
}

// ── Argument helpers ───────────────────────────────────────────

/** Return true if redirect target is safe (/dev/null or numeric fd). */
function isSafeRedirectTarget(file: AstWord): boolean {
  if (file.text === '/dev/null') return true;
  if (/^[0-9]+$/.test(file.text) || file.text === '-') return true;
  return false;
}

/** Extract the first non-redirect argument (index 0 after command name). */
function getFirstArg(node: AstCommand): string | undefined {
  if (!node.suffix) return undefined;
  for (const item of node.suffix) {
    if (item.type === 'Word') return (item as AstWord).text;
  }
  return undefined;
}

/** Extract non-flag directory arguments from a command node. */
function getDirArgs(node: AstCommand): string[] {
  if (!node.suffix) return [];
  const dirs: string[] = [];
  const argFlags = new Set(['-m', '-Z']);
  let skipNext = false;
  for (const item of node.suffix) {
    if (item.type === 'Word') {
      const text = (item as AstWord).text;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (text.startsWith('-')) {
        if (argFlags.has(text)) {
          skipNext = true;
        }
        continue;
      }
      dirs.push(text);
    }
  }
  return dirs;
}

/** Extract the n-th Word argument (1-indexed, skipping redirects). */
function getNthArg(node: AstCommand, n: number): string | undefined {
  if (!node.suffix) return undefined;
  let count = 0;
  for (const item of node.suffix) {
    if (item.type === 'Word') {
      count++;
      if (count === n) return (item as AstWord).text;
    }
  }
  return undefined;
}
