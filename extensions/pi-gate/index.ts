import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig, type ConfigResult } from './config.ts';
import { checkBashCommand } from './bash-guard.ts';
import { checkFileAccess } from './file-access.ts';
import { runPiGateBashCommand, runPiGateExternalCommand } from './command.ts';
import { registerVerdictRenderer, logJudgeOutcome } from './log.ts';
import { markPiGateLoaded, setBashEnabled, setExternalEnabled, getConfigResultOverride } from './session.ts';
import { initSharedState } from './state-log.ts';

/**
 * pi-gate extension: permissive-by-default file & bash access gate.
 *
 * Hooks into `tool_call` events to intercept `bash`, `read`, `write`,
 * `edit`, `grep`, and `find` tool invocations.  Project paths are allowed
 * by default; external paths and new bash
 * commands require explicit user approval during the session.
 *
 * Registers `/pi-gate-bash` and `/pi-gate-external` to toggle the bash and
 * external-path guards independently for the current session (both default
 * to on). Starting a new session (`/new`) re-enables both guards.
 *
 * Session approvals and guard toggles are shared across the main agent,
 * subagent children, and sibling pi sessions in the same project via an
 * append-only JSONL log at `$TMPDIR/pi-gate-<hash>/state.jsonl`. The log
 * expires (is truncated on next init) when the last session that created it
 * has exited, so approvals never outlive the session tree.
 */
export default function (pi: ExtensionAPI) {
  markPiGateLoaded();
  registerVerdictRenderer(pi);

  // Session state survives in the process across `/new` (pi reloads the
  // extension but globalThis persists), so explicitly re-enable both
  // guards when the user starts a fresh session.
  pi.on('session_start', async (event, ctx) => {
    initSharedState(ctx.cwd);
    if (event.reason !== 'new') return;
    setBashEnabled(true);
    setExternalEnabled(true);
  });

  pi.registerCommand('pi-gate-bash', {
    description: 'Toggle the pi-gate bash command-pattern guard for this session',
    handler: async (args, ctx) => runPiGateBashCommand(args, ctx, pi.events),
  });

  pi.registerCommand('pi-gate-external', {
    description: 'Toggle the pi-gate external file-path guard for this session',
    handler: async (args, ctx) => runPiGateExternalCommand(args, ctx, pi.events),
  });

  pi.on('tool_call', async (event, ctx) => {
    const configResult: ConfigResult = getConfigResultOverride() ?? loadConfig(ctx.cwd);

    if (event.toolName === 'bash') {
      const command = (event.input as { command?: string }).command;
      if (!command) return;

      const allowed = await checkBashCommand(command, ctx.cwd, configResult, ctx, {
        hooks: {
          onJudgeOutcome: (outcome, details, error) => logJudgeOutcome(pi, outcome, command, details, error),
        },
      });
      if (!allowed) {
        pi.events.emit('harness:block', {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          extension: 'pi-gate',
          reason: 'Blocked by pi-gate',
        });
        return { block: true, reason: 'Blocked by pi-gate' };
      }
      return;
    }

    const fileTools = ['read', 'write', 'edit', 'grep', 'find'];
    if (fileTools.includes(event.toolName)) {
      const path = (event.input as { path?: string }).path;
      if (!path) return;

      const allowed = await checkFileAccess(path, ctx.cwd, configResult, ctx);
      if (!allowed) {
        pi.events.emit('harness:block', {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          extension: 'pi-gate',
          reason: 'Blocked by pi-gate',
        });
        return { block: true, reason: 'Blocked by pi-gate' };
      }
      return;
    }

    return;
  });
}
