/**
 * Plan Mode Extension
 *
 * Toggle read-only planning mode. Blocks edit/write tools and
 * destructive bash commands. Injects planning instructions into
 * system prompt. Use /plan or --plan flag.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const BLOCK_REASON =
  "Blocked: Planning mode active. Present a plan instead — do not make changes. " +
  "Use /plan to exit planning mode when ready to implement.";

const PLAN_PROMPT = `[PLANNING MODE ACTIVE]
You are in planning mode. Read and analyze only.
1. Present a plan of requested work before any action. Never make changes.
2. Do not use bash to modify files, install packages, or change system state.
Tools edit/write are disabled. Use read, grep, find, ls for exploration.
When ready to implement, ask user to exit plan mode with /plan.`;

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bchgrp\b/,
  /\bln\b/,
  /\btee\b/,
  /\btruncate\b/,
  /\bdd\b/,
  /\bshred\b/,
  /(?:^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(?:-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/,
  /\bsu\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(?:vim?|nano|emacs|code|subl)\b/,
];

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

function updateStatus(pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
  if (enabled) {
    ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "⏸ plan"));
  } else {
    ctx.ui.setStatus("plan-mode", undefined);
  }
}

export default function (pi: ExtensionAPI): void {
  let planModeEnabled = false;

  function persist(): void {
    pi.appendEntry("plan-mode-state", { enabled: planModeEnabled });
  }

  function toggle(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      ctx.ui.notify("Plan mode enabled — edit/write/destructive bash blocked");
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
  pi.registerShortcut(Key.ctrlShift("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => toggle(ctx),
  });

  // Block destructive tool calls
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled) return;

    // Block write/edit entirely
    if (event.toolName === "edit" || event.toolName === "write") {
      return { block: true, reason: BLOCK_REASON };
    }

    // Block destructive bash
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (command && isDestructiveCommand(command)) {
        return { block: true, reason: BLOCK_REASON };
      }
    }
  });

  // Inject planning prompt
  pi.on("before_agent_start", async (event) => {
    if (!planModeEnabled) return;

    const chained = event.systemPrompt ?? "";
    return {
      systemPrompt: `${chained}\n\n${PLAN_PROMPT}`,
      message: {
        customType: "plan-mode-context",
        content: PLAN_PROMPT,
        display: false,
      },
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
