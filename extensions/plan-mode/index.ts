/**
 * Plan Mode Extension
 *
 * Toggle read-only planning mode. Blocks edit/write tools and
 * destructive bash commands. Injects planning instructions into
 * system prompt.
 * Plan mode is active by default. Use /plan to toggle, or --no-plan
 * to start a session without it.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key } from '@mariozechner/pi-tui';
import { isDestructiveCommand } from './bash-guard.ts';

const BLOCK_REASON =
  'Blocked: Planning mode active. Present a plan instead — do not make changes. ' +
  'Use /plan to exit planning mode when ready to implement.';

const PLAN_PROMPT = `[PLANNING MODE ACTIVE]
You are in planning mode. Read and analyze only.
1. Present a plan before any action. Never make changes.
2. Do NOT run commands that modify, install, or delete anything.
Tools edit/write are disabled. Use read, grep, find, ls for exploration.
3. If completing the user's request would require changes prohibited by planning mode, respond with an implementation plan you would follow to complete the request. If the plan involves multiple steps, use a multi-phase plan.
When ready, ask user to exit plan mode with /plan.`;

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
 * @returns Block instruction if the call should be blocked, otherwise `undefined`.
 */
export function evaluateToolCall(
  planModeEnabled: boolean,
  toolName: string,
  command?: string,
): { block: true; reason: string } | undefined {
  if (!planModeEnabled) {
    return undefined;
  }

  if (toolName === 'edit' || toolName === 'write') {
    return { block: true, reason: BLOCK_REASON };
  }

  if (toolName === 'bash' && command) {
    const reason = isDestructiveCommand(command);
    if (reason) {
      return { block: true, reason };
    }
  }

  return undefined;
}

/**
 * Augment the system prompt when plan mode is active.
 *
 * @param planModeEnabled - Whether plan mode is currently active.
 * @param existingPrompt - The current system prompt text.
 * @returns Object with augmented prompt if active, otherwise `undefined`.
 */
export function augmentSystemPrompt(
  planModeEnabled: boolean,
  existingPrompt: string,
): { systemPrompt: string } | undefined {
  if (!planModeEnabled) {
    return undefined;
  }

  return {
    systemPrompt: `${existingPrompt}\n\n${PLAN_PROMPT}`,
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

  function persist(): void {
    pi.appendEntry('plan-mode-state', { enabled: planModeEnabled });
  }

  function toggle(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      ctx.ui.notify('Plan mode enabled — edit/write/bash blocked');
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
  pi.on('tool_call', async (event) => {
    const command = (event.input as { command?: string }).command?.trim();
    return evaluateToolCall(planModeEnabled, event.toolName, command);
  });

  // Inject planning prompt into system prompt (ephemeral, per-turn).
  // No persistent message — avoids stale [PLANNING MODE ACTIVE] in
  // session history after plan mode is toggled off.
  pi.on('before_agent_start', async (event) => {
    return augmentSystemPrompt(planModeEnabled, event.systemPrompt ?? '');
  });

  // Restore state on session start
  pi.on('session_start', async (event, ctx) => {
    const noPlanFlag = pi.getFlag('no-plan') === true;

    const entries = ctx.sessionManager.getEntries();
    const persisted = entries
      .filter((e: { type: string; customType?: string }) => e.type === 'custom' && e.customType === 'plan-mode-state')
      .pop() as { data?: { enabled: boolean } } | undefined;
    const persistedEnabled = persisted?.data?.enabled;

    planModeEnabled = resolvePlanModeOnSessionStart(event.reason, noPlanFlag, persistedEnabled);
    updateStatus(pi, planModeEnabled, ctx);
  });
}
