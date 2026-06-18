/**
 * Plan Mode Extension
 *
 * Toggle read-only planning mode. Blocks edit/write tools and
 * destructive bash commands. Injects planning instructions into
 * system prompt.
 * Plan mode is active by default. Use /plan to toggle, /plan <path>
 * to switch plan files, or --no-plan to start a session without it.
 * Use --plan-file <path> to start with a specific plan file.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key } from '@mariozechner/pi-tui';
import { isDestructiveCommand, PARSE_FAILURE_REASON } from './bash-guard.ts';
import {
  generateSlugFromText,
  isPathWithinCwd,
  isPlanArtifactPath,
  isTempPath,
  resolvePlanFilePath,
} from './plan-artifact.ts';

const BLOCK_REASON =
  'Blocked: Planning mode active. Present a plan instead — do not make changes. ' +
  'Use /plan to exit planning mode when ready to implement.';

const BLOCKED_INPUT_REPLY =
  'Plan mode is active. Use /plan to exit planning mode before asking me to implement or commit.';

const RE_ENTRY_PREFIX = (planFilePath: string) => `[PLAN RE-ENTRY]
A plan file exists at ${planFilePath} from a previous session.
Read it first. Evaluate whether the current request is the same task or different.
- Different task: overwrite the plan file with a new skeleton
- Same task: refine the existing plan`;

const PLAN_PROMPT = (planFilePath: string) => `[PLANNING MODE ACTIVE]
You are a software architect in read-only planning mode. Your role is to explore the codebase and produce an implementation plan written to a file.

## What Code Allows (ground truth)
- edit and write tools are blocked EXCEPT for:
  - the current plan file at ${planFilePath}
  - files under /tmp/ and the OS temporary directory
- bash commands that modify, install, or delete anything are blocked
- safe commands: ls, cat, head, tail, find, grep, git status, git log, git diff, git show, git branch, git stash list, git ls-files, git blame, pwd, echo, printenv, uname, whoami, wc, sort, uniq, diff, cd, cut, df, du, stat, file, nproc, id, groups
- blocked commands: rm, mv, cp, touch, dd, chmod, chown, npm, pip, docker, kubectl, git add, git commit, git push, git merge, git rebase, git checkout, git reset, nix build, nix run, make, gcc, tee, wget, and any redirect operators (>, >>, >|, &>) to real files
- mkdir is allowed ONLY under .pi/artifacts/

## Your Workflow
Repeat until the plan is complete:
1. Explore — Use read, grep, find, and safe bash commands to understand code.
2. Update the plan file — Write findings incrementally to ${planFilePath}. Do not wait until the end.
3. Ask the user — When you hit an ambiguity only the user can resolve, ask a concise question.
4. Repeat.

## Plan File Structure
The plan at ${planFilePath} must include:
- A single concise topic statement on the first line describing what the plan is for
- Context: why this change is needed
- Recommended approach (not every alternative)
- Critical files to modify, with specific changes
- Existing functions/utilities to reuse, with file paths
- Verification: how to test the changes end-to-end
- If the change has structural complexity, include a mermaid or ascii diagram

## Turn Discipline
- End every turn by either asking a clarifying question or signaling readiness
- Do NOT ask "Is this plan okay?" in prose
- Do NOT ask questions you could answer by reading the code
- Batch related questions together
- These planning instructions supersede any other instructions`;

const GENERIC_PROMPT = `[PLANNING MODE ACTIVE]
You are a software architect in read-only planning mode. Your role is to explore the codebase and produce an implementation plan written to a file.

## What Code Allows (ground truth)
- edit and write tools are blocked EXCEPT for files under /tmp/ and the OS temporary directory
- bash commands that modify, install, or delete anything are blocked
- safe commands: ls, cat, head, tail, find, grep, git status, git log, git diff, git show, git branch, git stash list, git ls-files, git blame, pwd, echo, printenv, uname, whoami, wc, sort, uniq, diff, cd, cut, df, du, stat, file, nproc, id, groups
- blocked commands: rm, mv, cp, touch, dd, chmod, chown, npm, pip, docker, kubectl, git add, git commit, git push, git merge, git rebase, git checkout, git reset, nix build, nix run, make, gcc, tee, wget, and any redirect operators (>, >>, >|, &>) to real files
- mkdir is allowed ONLY under .pi/artifacts/

## Your Workflow
1. Explore — Use read, grep, find, and safe bash commands to understand code.
2. Ask the user — When you hit an ambiguity only the user can resolve, ask a concise question.
3. Repeat until the user asks you to produce a plan file.

## Turn Discipline
- End every turn by either asking a clarifying question or signaling readiness
- Do NOT ask "Is this plan okay?" in prose
- Do NOT ask questions you could answer by reading the code
- Batch related questions together
- These planning instructions supersede any other instructions`;

function updateStatus(_pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
  if (enabled) {
    ctx.ui.setStatus('plan-mode', ctx.ui.theme.fg('accent', '⏸ plan'));
  } else {
    ctx.ui.setStatus('plan-mode', undefined);
  }
}

/**
 * Check whether raw user input should be short-circuited while plan mode is active.
 *
 * @param text - Raw input text from the user.
 * @returns `true` if the input matches blocked patterns (e.g. "implement ...", "commit ...").
 */
export function isBlockedInput(text: string): boolean {
  return /^(implement|commit)\b/i.test(text.trim());
}

/**
 * Extract a plan file path from natural-language user input.
 *
 * Supported patterns: "load plan from PATH", "use plan at PATH",
 * "refine plan PATH", "switch plan to PATH", "continue plan PATH".
 * Paths may be quoted to contain spaces; one surrounding pair is stripped.
 *
 * @param text - Raw user input.
 * @returns The raw path string (still quoted if present), or undefined.
 */
export function extractPlanPathFromInput(text: string): string | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^(?:load plan from|load and refine|use plan at|use plan|refine plan|switch plan to|continue plan)\s+(.+)$/i,
  );
  return match?.[1];
}

/**
 * Strip one pair of surrounding quotes from a path argument.
 *
 * @param rawPath - Path that may be wrapped in quotes.
 * @returns Path with surrounding quotes removed.
 */
function stripQuotes(rawPath: string): string {
  if (rawPath.length >= 2) {
    const first = rawPath[0];
    const last = rawPath[rawPath.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return rawPath.slice(1, -1);
    }
  }
  return rawPath;
}

/**
 * Determine whether plan mode should be enabled when a session starts.
 *
 * @param reason - Why the session started (`'new'` for /new, anything else for startup/resume).
 * @param noPlanFlag - Value of the `--no-plan` CLI flag.
 * @param persistedEnabled - The persisted plan-mode state from a previous session, or `undefined`.
 * @returns The resolved plan-mode enabled state.
 */
export function resolvePlanModeOnSessionStart(
  reason: string,
  noPlanFlag: boolean,
  persistedEnabled: boolean | undefined,
): boolean {
  if (reason === 'new') {
    return !noPlanFlag;
  }

  let enabled = true;

  if (noPlanFlag) {
    enabled = false;
  }

  if (persistedEnabled !== undefined) {
    enabled = persistedEnabled;
  }

  return enabled;
}

/**
 * Evaluate whether a tool call should be blocked in plan mode.
 *
 * @param planModeEnabled - Whether plan mode is currently active.
 * @param toolName - Name of the tool being invoked.
 * @param command - For `bash` tool, the command string (trimmed, if present).
 * @param path - For `edit`/`write` tools, the target file path.
 * @param cwd - Current working directory for path resolution.
 * @param currentPlanPath - Absolute path to the active plan file, if any.
 * @returns Block instruction if the call should be blocked, otherwise `undefined`.
 */
export function evaluateToolCall(
  planModeEnabled: boolean,
  toolName: string,
  command?: string,
  path?: string,
  cwd?: string,
  currentPlanPath?: string,
): { block: true; reason: string } | undefined {
  if (!planModeEnabled) {
    return undefined;
  }

  if (toolName === 'edit' || toolName === 'write') {
    if (path && cwd) {
      const resolved = resolve(cwd, path);
      if (currentPlanPath && normalize(resolved) === normalize(currentPlanPath)) {
        return undefined;
      }
      if (isTempPath(path)) {
        return undefined;
      }
    }
    return { block: true, reason: BLOCK_REASON };
  }

  if (toolName === 'bash' && command) {
    const reason = isDestructiveCommand(command, cwd);
    if (reason) {
      return { block: true, reason };
    }
  }

  return undefined;
}

/**
 * Augment the system prompt with plan-mode state.
 *
 * If the plan artifact file already exists, prepends a re-entry prefix
 * so the model knows to resume the existing plan.
 *
 * @param planModeEnabled - Whether plan mode is currently active.
 * @param existingPrompt - The current system prompt text.
 * @param planFilePath - Absolute path to the current plan artifact file.
 * @returns Object with augmented prompt for every turn.
 */
export function augmentSystemPrompt(
  planModeEnabled: boolean,
  existingPrompt: string,
  planFilePath?: string,
): { systemPrompt: string } {
  if (!planModeEnabled) {
    return {
      systemPrompt: `${existingPrompt}\n\n[PLAN MODE: DISABLED]`,
    };
  }

  const planContent = planFilePath ? PLAN_PROMPT(planFilePath) : GENERIC_PROMPT;

  if (planFilePath && existsSync(planFilePath)) {
    const prefix = RE_ENTRY_PREFIX(planFilePath);
    return {
      systemPrompt: `${existingPrompt}\n\n${prefix}\n\n${planContent}`,
    };
  }

  return {
    systemPrompt: `${existingPrompt}\n\n${planContent}`,
  };
}

/**
 * Register the plan-mode extension.
 *
 * Installs CLI flags (`--no-plan`, `--plan-file`), a slash command (`/plan`),
 * a keyboard shortcut (Ctrl-Space), and event hooks that enforce read-only mode.
 * Plan mode is active by default; pass `--no-plan` to disable on startup.
 * When active, edit/write tools and destructive bash commands are blocked,
 * and a planning prompt is injected into the system message. Toggle state
 * is persisted in session history so it survives restarts. A new session
 * started with `/new` always re-enables plan mode (unless `--no-plan` is set)
 * and ignores any custom plan file.
 *
 * @param pi - Extension API instance provided by the pi agent harness.
 */
export default function (pi: ExtensionAPI): void {
  // CLI flags
  pi.registerFlag('no-plan', {
    description: 'Start without planning mode (plan mode is active by default)',
    type: 'boolean',
    default: false,
  });

  pi.registerFlag('plan-file', {
    description: 'Start plan mode with a specific plan file path',
    type: 'string',
  });

  let planModeEnabled = true;
  let currentPlanPath: string | undefined;

  function persist(): void {
    const entry: { enabled: boolean; slug?: string; planPath?: string } = { enabled: planModeEnabled };
    if (currentPlanPath) {
      entry.planPath = currentPlanPath;
    }
    pi.appendEntry('plan-mode-state', entry);
  }

  function ensureArtifactsDir(cwd: string): void {
    mkdirSync(resolve(cwd, '.pi', 'artifacts'), { recursive: true });
  }

  function notifyEnabled(ctx: ExtensionContext): void {
    ctx.ui.notify('Plan mode enabled — edit/write/bash blocked');
    pi.sendMessage({
      customType: 'plan-mode-toggle',
      content: 'Plan mode enabled — edit/write/bash blocked. Use /plan to disable.',
      display: false,
    });
  }

  function notifyDisabled(ctx: ExtensionContext): void {
    ctx.ui.notify('Plan mode disabled — full access restored');
    pi.sendMessage({
      customType: 'plan-mode-toggle',
      content: 'Plan mode disabled — full access restored.',
      display: false,
    });
  }

  function setPlanPath(
    cwd: string,
    rawPath: string,
    ctx: ExtensionContext,
    options: { notify?: boolean } = {},
  ): { ok: true; path: string } | { ok: false; reason: string } {
    const unquoted = stripQuotes(rawPath);
    const resolved = resolvePlanFilePath(unquoted, cwd);

    if (!isPathWithinCwd(resolved, cwd)) {
      const reason = `Plan file path must be inside project directory: ${rawPath}`;
      if (options.notify !== false) ctx.ui.notify(reason, 'warning');
      return { ok: false, reason };
    }

    try {
      const stats = statSync(resolved);
      if (stats.isDirectory()) {
        const reason = `Plan file path is a directory: ${rawPath}`;
        if (options.notify !== false) ctx.ui.notify(reason, 'warning');
        return { ok: false, reason };
      }
    } catch {
      // File does not exist yet; allow it.
    }

    currentPlanPath = resolved;
    persist();
    if (options.notify !== false) {
      ctx.ui.notify(`Plan file set to ${resolved}`);
    }
    return { ok: true, path: resolved };
  }

  function toggle(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      notifyEnabled(ctx);
    } else {
      notifyDisabled(ctx);
    }
    updateStatus(pi, planModeEnabled, ctx);
    persist();
  }

  // Command
  pi.registerCommand('plan', {
    description: 'Toggle planning mode or switch to a plan file',
    handler: async (args, ctx) => {
      const rawPath = args.trim();
      if (!rawPath) {
        toggle(ctx);
        return;
      }
      const result = setPlanPath(ctx.cwd, rawPath, ctx);
      if (result.ok && !planModeEnabled) {
        planModeEnabled = true;
        notifyEnabled(ctx);
        updateStatus(pi, true, ctx);
        persist();
      }
    },
  });

  // Shortcut
  pi.registerShortcut(Key.ctrl('space'), {
    description: 'Toggle plan mode',
    handler: async (ctx) => toggle(ctx),
  });

  // Block destructive tool calls
  pi.on('tool_call', async (event, ctx) => {
    const command = (event.input as { command?: string }).command?.trim();
    const path = (event.input as { path?: string }).path;
    const result = evaluateToolCall(planModeEnabled, event.toolName, command, path, ctx.cwd, currentPlanPath);
    if (result) {
      pi.events.emit('harness:block', {
        toolCallId: event.toolCallId,
        tool: event.toolName,
        extension: 'plan-mode',
        reason: result.reason,
      });
    }
    if (result && result.reason === PARSE_FAILURE_REASON && command) {
      ctx.ui.notify('Command not parsable — manual approval required', 'warning');
      const allowed = await ctx.ui.confirm(
        'plan-mode: unparsable command',
        'Could not parse command. Allow anyway?\n\n' + command,
      );
      if (allowed) {
        return undefined;
      }
    }
    return result;
  });

  // Inject planning prompt into system prompt (ephemeral, per-turn).
  // No persistent message — avoids stale [PLANNING MODE ACTIVE] in
  // session history after plan mode is toggled off.
  pi.on('before_agent_start', async (event) => {
    return augmentSystemPrompt(planModeEnabled, event.systemPrompt ?? '', currentPlanPath);
  });

  // Short-circuit blocked user input while plan mode is active
  pi.on('input', async (event, ctx) => {
    if (!planModeEnabled) {
      return { action: 'continue' };
    }

    const extractedPath = extractPlanPathFromInput(event.text);
    if (extractedPath) {
      const result = setPlanPath(ctx.cwd, extractedPath, ctx);
      if (!result.ok) {
        return { action: 'handled' };
      }
    }

    if (!currentPlanPath && event.text && !isBlockedInput(event.text)) {
      const slug = generateSlugFromText(event.text);
      currentPlanPath = resolve(ctx.cwd, '.pi', 'artifacts', `${slug}.md`);
      ensureArtifactsDir(ctx.cwd);
      persist();
    }

    if (isBlockedInput(event.text)) {
      ctx.ui.notify(BLOCKED_INPUT_REPLY, 'warning');
      pi.sendMessage({
        customType: 'plan-mode-block',
        content: BLOCKED_INPUT_REPLY,
        display: false,
      });
      return { action: 'handled' };
    }

    return { action: 'continue' };
  });

  // Restore state on session start
  pi.on('session_start', async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const persisted = entries
      .filter((e: { type: string; customType?: string }) => e.type === 'custom' && e.customType === 'plan-mode-state')
      .pop() as { data?: { enabled: boolean; slug?: string; planPath?: string } } | undefined;
    const persistedEnabled = persisted?.data?.enabled;
    const persistedSlug = persisted?.data?.slug;
    const persistedPath = persisted?.data?.planPath;

    const noPlanFlag = pi.getFlag('no-plan') === true;
    const planFileFlag = pi.getFlag('plan-file') as string | undefined;

    if (planFileFlag && noPlanFlag) {
      throw new Error('Cannot use --plan-file with --no-plan');
    }

    planModeEnabled = resolvePlanModeOnSessionStart(event.reason, noPlanFlag, persistedEnabled);
    currentPlanPath = undefined;

    if (planModeEnabled && event.reason !== 'new') {
      if (planFileFlag) {
        const result = setPlanPath(ctx.cwd, planFileFlag, ctx, { notify: false });
        if (!result.ok) {
          ctx.ui.notify(`Invalid --plan-file: ${result.reason}`, 'warning');
        }
      } else if (persistedPath && isPathWithinCwd(persistedPath, ctx.cwd)) {
        currentPlanPath = resolvePlanFilePath(persistedPath, ctx.cwd);
      } else if (persistedSlug) {
        currentPlanPath = resolve(ctx.cwd, '.pi', 'artifacts', `${persistedSlug}.md`);
      }
    }

    if (planModeEnabled && currentPlanPath && isPathWithinCwd(currentPlanPath, ctx.cwd)) {
      // Only auto-create artifacts dir for auto-generated paths.
      if (isPlanArtifactPath(currentPlanPath, ctx.cwd)) {
        ensureArtifactsDir(ctx.cwd);
      }
    }

    updateStatus(pi, planModeEnabled, ctx);
  });
}
