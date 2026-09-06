import type { EventBus, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { getSessionState, isBashEnabled, setBashEnabled, isExternalEnabled, setExternalEnabled } from './session.ts';

/** Toggleable pi-gate guard systems. */
export type GuardSystem = 'bash' | 'external';

const TOGGLE_OPTIONS = ['bash on', 'bash off', 'external on', 'external off'] as const;

function setSystemEnabled(system: GuardSystem, enabled: boolean, events: EventBus): void {
  if (system === 'bash') {
    setBashEnabled(enabled);
  } else {
    setExternalEnabled(enabled);
  }
  events.emit('pi-gate:toggled', { system, enabled });
}

/** Human-readable summary of both guard states plus session approval counts. */
export function statusMessage(): string {
  const s = getSessionState();
  const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
  return (
    `pi-gate (session): bash guard ${onOff(isBashEnabled())}, ` +
    `external path guard ${onOff(isExternalEnabled())} — ` +
    `${s.approvedBashPatterns.size} bash pattern(s), ` +
    `${s.approvedExternalPatterns.size} external path(s) approved`
  );
}

/** Parse `"bash on"` / `"external off"` style argument pairs. */
function parseToggle(tokens: string[]): { system: GuardSystem; enabled: boolean } | null {
  if (tokens.length !== 2) return null;
  const system = tokens[0]!.toLowerCase();
  const state = tokens[1]!.toLowerCase();
  if (system !== 'bash' && system !== 'external') return null;
  if (state !== 'on' && state !== 'off') return null;
  return { system, enabled: state === 'on' };
}

/** Argument completions offered by the `/pi-gate` command. */
export function piGateCompletions(prefix: string): Array<{ value: string; label: string }> | null {
  const items = [...TOGGLE_OPTIONS, 'status'].map((v) => ({ value: v, label: v }));
  const filtered = items.filter((i) => i.value.startsWith(prefix.trim()));
  return filtered.length > 0 ? filtered : null;
}

/** Label for one picker entry, reflecting the guard's current state. */
function pickerLabel(system: GuardSystem): string {
  const enabled = system === 'bash' ? isBashEnabled() : isExternalEnabled();
  return `${system} (${enabled ? 'ON' : 'OFF'})`;
}

/**
 * Run the interactive picker: one entry per guard. Selecting an entry
 * flips that guard and re-shows the picker with refreshed labels; the
 * user exits by cancelling the picker.
 */
async function runPicker(ctx: ExtensionCommandContext, events: EventBus): Promise<void> {
  for (;;) {
    const options = [pickerLabel('bash'), pickerLabel('external')];
    const choice = await ctx.ui.select(`${statusMessage()}\nToggle which guard?`, options);
    if (!choice) return;

    if (choice.startsWith('bash')) {
      setSystemEnabled('bash', !isBashEnabled(), events);
      ctx.ui.notify(`pi-gate: bash guard ${isBashEnabled() ? 'ON' : 'OFF'} (session)`, 'info');
    } else if (choice.startsWith('external')) {
      setSystemEnabled('external', !isExternalEnabled(), events);
      ctx.ui.notify(`pi-gate: external guard ${isExternalEnabled() ? 'ON' : 'OFF'} (session)`, 'info');
    } else {
      return;
    }
  }
}

/**
 * Entry point for the `/pi-gate` slash command: toggles the bash and
 * external-path guards independently for the current session.
 *
 * Usage:
 *   /pi-gate                  — interactive picker (one entry per guard)
 *   /pi-gate status           — show current guard states
 *   /pi-gate bash on|off      — toggle the bash command-pattern guard
 *   /pi-gate external on|off  — toggle the external file-path guard
 *
 * @param args - Raw argument string passed after `/pi-gate`.
 * @param ctx - Pi extension command context providing UI primitives.
 * @param events - Shared event bus used to emit `pi-gate:toggled` on guard changes.
 */
export async function runPiGateCommand(args: string, ctx: ExtensionCommandContext, events: EventBus): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens[0] === 'status') {
    ctx.ui.notify(statusMessage(), 'info');
    return;
  }

  const toggle = parseToggle(tokens);

  if (!toggle && tokens.length > 0) {
    ctx.ui.notify(
      `pi-gate: unknown usage "${args.trim()}"\nUsage: /pi-gate [bash|external] [on|off] | status`,
      'warning',
    );
    return;
  }

  if (!toggle) {
    await runPicker(ctx, events);
    return;
  }

  setSystemEnabled(toggle.system, toggle.enabled, events);
  ctx.ui.notify(`pi-gate: ${toggle.system} guard ${toggle.enabled ? 'ON' : 'OFF'} (session)`, 'info');
}
