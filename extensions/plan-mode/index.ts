/**
 * Plan Mode Extension
 *
 * Toggle read-only planning mode. Blocks edit/write tools and
 * destructive bash commands. Injects planning instructions into
 * system prompt.
 * Plan mode is active by default. Use /plan to toggle, or --no-plan
 * to start a session without it.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key } from '@mariozechner/pi-tui';
import { isDestructiveCommand } from './bash-guard.ts';
import { generatePlanSlug, isPlanArtifactPath, isTempPath } from './plan-artifact.ts';

const BLOCK_REASON =
  'Blocked: Planning mode active. Present a plan instead — do not make changes. ' +
  'Use /plan to exit planning mode when ready to implement.';

const RE_ENTRY_PREFIX = (planFilePath: string) => `[PLAN RE-ENTRY]
A plan file exists at ${planFilePath} from a previous session.
Read it first. Evaluate whether the current request is the same task or different.
- Different task: overwrite the plan file with a new skeleton
- Same task: refine the existing plan`;

const PLAN_PROMPT = (planFilePath: string) => `[PLANNING MODE ACTIVE]
You are a software architect in read-only planning mode. Your role is to explore the codebase and produce an implementation plan written to a file.

## What Code Allows (ground truth)
- edit and write tools are blocked EXCEPT for:
  - plan-artifact files under .pi/artifacts/ (e.g. ${planFilePath})
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

function updateStatus(_pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
  if (enabled) {
    ctx.ui.setStatus('plan-mode', ctx.ui.theme.fg('accent', '⏸ plan'));
  } else {
    ctx.ui.setStatus('plan-mode', undefined);
  }
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
 * @returns Block instruction if the call should be blocked, otherwise `undefined`.
 */
export function evaluateToolCall(
  planModeEnabled: boolean,
  toolName: string,
  command?: string,
  path?: string,
  cwd?: string,
): { block: true; reason: string } | undefined {
  if (!planModeEnabled) {
    return undefined;
  }

  if (toolName === 'edit' || toolName === 'write') {
    if (path && cwd && (isPlanArtifactPath(path, cwd) || isTempPath(path))) {
      return undefined;
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
 * Augment the system prompt when plan mode is active.
 *
 * If the plan artifact file already exists, prepends a re-entry prefix
 * so the model knows to resume the existing plan.
 *
 * @param planModeEnabled - Whether plan mode is currently active.
 * @param existingPrompt - The current system prompt text.
 * @param planFilePath - Absolute path to the current plan artifact file.
 * @returns Object with augmented prompt if active, otherwise `undefined`.
 */
export function augmentSystemPrompt(
  planModeEnabled: boolean,
  existingPrompt: string,
  planFilePath?: string,
): { systemPrompt: string } | undefined {
  if (!planModeEnabled) {
    return undefined;
  }

  const path = planFilePath ?? '.pi/artifacts/plan-<slug>.md';
  const planContent = PLAN_PROMPT(path);

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
 * Installs a CLI flag (`--no-plan`), a slash command (`/plan`), a keyboard
 * shortcut (Ctrl-Shift-Z), and event hooks that enforce read-only mode.
 * Plan mode is active by default; pass `--no-plan` to disable on startup.
 * When active, edit/write tools and destructive bash commands are blocked,
 * and a planning prompt is injected into the system message. Toggle state
 * is persisted in session history so it survives restarts. A new session
 * started with `/new` always re-enables plan mode (unless `--no-plan` is set).
 *
 * @param pi - Extension API instance provided by the pi agent harness.
 */
export default function (pi: ExtensionAPI): void {
  let planModeEnabled = true;
  let currentPlanSlug: string | undefined;

  function persist(): void {
    pi.appendEntry('plan-mode-state', { enabled: planModeEnabled, slug: currentPlanSlug });
  }

  function ensureArtifactsDir(cwd: string): void {
    mkdirSync(resolve(cwd, '.pi', 'artifacts'), { recursive: true });
  }

  function toggle(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      ctx.ui.notify('Plan mode enabled — edit/write/bash blocked');
      if (!currentPlanSlug) {
        currentPlanSlug = generatePlanSlug();
      }
      ensureArtifactsDir(ctx.cwd);
    } else {
      ctx.ui.notify('Plan mode disabled — full access restored');
    }
    updateStatus(pi, planModeEnabled, ctx);
    persist();
  }

  // CLI flag
  pi.registerFlag('no-plan', {
    description: 'Start without planning mode (plan mode is active by default)',
    type: 'boolean',
    default: false,
  });

  // Command
  pi.registerCommand('plan', {
    description: 'Toggle planning mode',
    handler: async (_args, ctx) => toggle(ctx),
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
    return evaluateToolCall(planModeEnabled, event.toolName, command, path, ctx.cwd);
  });

  // Inject planning prompt into system prompt (ephemeral, per-turn).
  // No persistent message — avoids stale [PLANNING MODE ACTIVE] in
  // session history after plan mode is toggled off.
  pi.on('before_agent_start', async (event, ctx) => {
    const planFilePath = currentPlanSlug ? resolve(ctx.cwd, '.pi', 'artifacts', `${currentPlanSlug}.md`) : undefined;
    return augmentSystemPrompt(planModeEnabled, event.systemPrompt ?? '', planFilePath);
  });

  // Restore state on session start
  pi.on('session_start', async (event, ctx) => {
    const noPlanFlag = pi.getFlag('no-plan') === true;

    const entries = ctx.sessionManager.getEntries();
    const persisted = entries
      .filter((e: { type: string; customType?: string }) => e.type === 'custom' && e.customType === 'plan-mode-state')
      .pop() as { data?: { enabled: boolean; slug?: string } } | undefined;
    const persistedEnabled = persisted?.data?.enabled;
    const persistedSlug = persisted?.data?.slug;

    planModeEnabled = resolvePlanModeOnSessionStart(event.reason, noPlanFlag, persistedEnabled);

    if (planModeEnabled) {
      currentPlanSlug = persistedSlug ?? generatePlanSlug();
      ensureArtifactsDir(ctx.cwd);
    }

    updateStatus(pi, planModeEnabled, ctx);
  });
}
