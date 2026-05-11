/**
 * Plan Mode Extension
 *
 * Toggle read-only planning mode. Blocks edit/write tools and
 * destructive bash commands. Injects planning instructions into
 * system prompt.
 * Use /plan or --plan flag.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { isDestructiveCommand } from "./bash-guard.ts";

const BLOCK_REASON =
  "Blocked: Planning mode active. Present a plan instead — do not make changes. " +
  "Use /plan to exit planning mode when ready to implement.";

const PLAN_PROMPT = `[PLANNING MODE ACTIVE]
You are in planning mode. Read and analyze only.
1. Present a plan before any action. Never make changes.
2. Do NOT run commands that modify, install, or delete anything.
Tools edit/write are disabled. Use read, grep, find, ls for exploration.
When ready, ask user to exit plan mode with /plan.`;

function updateStatus(_pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
  if (enabled) {
    ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "⏸ plan"));
  } else {
    ctx.ui.setStatus("plan-mode", undefined);
  }
}

/**
 * Register the plan-mode extension.
 *
 * Installs a CLI flag (`--plan`), a slash command (`/plan`), a keyboard
 * shortcut (Ctrl-Shift-Z), and event hooks that enforce read-only mode.
 * When active, edit/write tools and destructive bash commands are blocked,
 * and a planning prompt is injected into the system message.  Toggle state
 * is persisted in session history so it survives restarts.
 *
 * @param pi - Extension API instance provided by the pi agent harness.
 */
export default function (pi: ExtensionAPI): void {
  let planModeEnabled = false;

  function persist(): void {
    pi.appendEntry("plan-mode-state", { enabled: planModeEnabled });
  }

  function toggle(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      ctx.ui.notify("Plan mode enabled — edit/write/bash blocked");
    } else {
      ctx.ui.notify("Plan mode disabled — full access restored");
    }
    updateStatus(pi, planModeEnabled, ctx);
    persist();
  }

  // CLI flag
  pi.registerFlag("plan", {
    description: "Start in planning mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // Command
  pi.registerCommand("plan", {
    description: "Toggle planning mode",
    handler: async (_args, ctx) => toggle(ctx),
  });

  // Shortcut
  pi.registerShortcut(Key.ctrlShift("z"), {
    description: "Toggle plan mode",
    handler: async (ctx) => toggle(ctx),
  });

  // Block destructive tool calls
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: BLOCK_REASON };
    }

    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command?.trim();
      if (!command) return;

      const reason = isDestructiveCommand(command);
      if (reason) {
        return { block: true, reason };
      }
    }

    return;
  });

  // Inject planning prompt into system prompt (ephemeral, per-turn).
  // No persistent message — avoids stale [PLANNING MODE ACTIVE] in
  // session history after plan mode is toggled off.
  pi.on("before_agent_start", async (event) => {
    if (!planModeEnabled) return;
    return {
      systemPrompt: `${event.systemPrompt ?? ""}\n\n${PLAN_PROMPT}`,
    };
  });

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    // Restore persisted toggle state
    const entries = ctx.sessionManager.getEntries();
    const persisted = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode-state",
      )
      .pop() as { data?: { enabled: boolean } } | undefined;

    if (persisted?.data?.enabled !== undefined) {
      planModeEnabled = persisted.data.enabled;
    }

    updateStatus(pi, planModeEnabled, ctx);
  });
}
