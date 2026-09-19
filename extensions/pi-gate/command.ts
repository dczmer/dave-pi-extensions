import type { EventBus, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { isBashEnabled, setBashEnabled, isExternalEnabled, setExternalEnabled } from './session.ts';

/** Toggleable pi-gate guard systems. */
export type GuardSystem = 'bash' | 'external';

/** Human-readable guard label used in notifications. */
const GUARD_LABEL: Record<GuardSystem, string> = {
  bash: 'bash guard',
  external: 'external guard',
};

/**
 * Flip one guard for the current session and announce the change on the
 * shared event bus so other extensions can re-render (e.g. the footer
 * indicators in context-usage-bar).
 *
 * @param system - Guard to flip.
 * @param events - Shared event bus used to emit `pi-gate:toggled`.
 * @returns The guard's state after the flip.
 */
function toggleSystem(system: GuardSystem, events: EventBus): boolean {
  const enabled = !(system === 'bash' ? isBashEnabled() : isExternalEnabled());
  if (system === 'bash') {
    setBashEnabled(enabled);
  } else {
    setExternalEnabled(enabled);
  }
  events.emit('pi-gate:toggled', { system, enabled });
  return enabled;
}

/**
 * Shared implementation for the per-guard toggle commands: flips the
 * guard and notifies, or warns when unexpected arguments are supplied.
 *
 * @param system - Guard toggled by the calling command.
 * @param args - Raw argument string passed after the command name.
 * @param ctx - Pi extension command context providing UI primitives.
 * @param events - Shared event bus used to emit `pi-gate:toggled`.
 */
function runToggleCommand(system: GuardSystem, args: string, ctx: ExtensionCommandContext, events: EventBus): void {
  if (args.trim().length > 0) {
    ctx.ui.notify(`pi-gate: /pi-gate-${system} takes no arguments`, 'warning');
    return;
  }

  const enabled = toggleSystem(system, events);
  ctx.ui.notify(`pi-gate: ${GUARD_LABEL[system]} ${enabled ? 'ON' : 'OFF'} (session)`, 'info');
}

/**
 * Entry point for `/pi-gate-bash`: toggles the bash command-pattern guard
 * for the current session.
 *
 * @param args - Raw argument string passed after `/pi-gate-bash` (must be empty).
 * @param ctx - Pi extension command context providing UI primitives.
 * @param events - Shared event bus used to emit `pi-gate:toggled` on guard changes.
 */
export async function runPiGateBashCommand(
  args: string,
  ctx: ExtensionCommandContext,
  events: EventBus,
): Promise<void> {
  runToggleCommand('bash', args, ctx, events);
}

/**
 * Entry point for `/pi-gate-external`: toggles the external file-path
 * guard for the current session.
 *
 * @param args - Raw argument string passed after `/pi-gate-external` (must be empty).
 * @param ctx - Pi extension command context providing UI primitives.
 * @param events - Shared event bus used to emit `pi-gate:toggled` on guard changes.
 */
export async function runPiGateExternalCommand(
  args: string,
  ctx: ExtensionCommandContext,
  events: EventBus,
): Promise<void> {
  runToggleCommand('external', args, ctx, events);
}
