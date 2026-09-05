import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { getSessionState, isBashEnabled, setBashEnabled, isExternalEnabled, setExternalEnabled } from './session.ts';

/** Toggleable pi-gate guard systems. */
export type GuardSystem = 'bash' | 'external';

const TOGGLE_OPTIONS = ['bash on', 'bash off', 'external on', 'external off'] as const;

function setSystemEnabled(system: GuardSystem, enabled: boolean): void {
  if (system === 'bash') {
    setBashEnabled(enabled);
  } else {
    setExternalEnabled(enabled);
  }
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

/**
 * Entry point for the `/pi-gate` slash command: toggles the bash and
 * external-path guards independently for the current session.
 *
 * Usage:
 *   /pi-gate                  — interactive picker
 *   /pi-gate status           — show current guard states
 *   /pi-gate bash on|off      — toggle the bash command-pattern guard
 *   /pi-gate external on|off  — toggle the external file-path guard
 *
 * @param args - Raw argument string passed after `/pi-gate`.
 * @param ctx - Pi extension command context providing UI primitives.
 */
export async function runPiGateCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens[0] === 'status') {
    ctx.ui.notify(statusMessage(), 'info');
    return;
  }

  let toggle = parseToggle(tokens);

  if (!toggle && tokens.length > 0) {
    ctx.ui.notify(
      `pi-gate: unknown usage "${args.trim()}"\nUsage: /pi-gate [bash|external] [on|off] | status`,
      'warning',
    );
    return;
  }

  if (!toggle) {
    const choice = await ctx.ui.select(`${statusMessage()}\nToggle which guard?`, [...TOGGLE_OPTIONS]);
    if (!choice) return;
    toggle = parseToggle(choice.split(/\s+/));
    if (!toggle) return;
  }

  setSystemEnabled(toggle.system, toggle.enabled);
  ctx.ui.notify(`pi-gate: ${toggle.system} guard ${toggle.enabled ? 'ON' : 'OFF'} (session)`, 'info');
}
