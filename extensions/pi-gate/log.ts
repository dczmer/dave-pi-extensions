import type { ExtensionAPI, ThemeColor } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import type { JudgeOutcome, JudgeVerdictDetails } from './judge.ts';

/** Custom entry type for pi-gate judge verdict messages. */
export const VERDICT_ENTRY_TYPE = 'pi-gate-verdict';

const MESSAGES: Record<JudgeOutcome, string> = {
  allowed: 'pi-gate: Allowed bash command.',
  denied: 'pi-gate: Denied bash command.',
  'no-judge': 'pi-gate: No judge LLM. Escalating to user.',
  unavailable: 'pi-gate: Verification model unavailable. Escalating to user.',
  error: 'pi-gate: Error calling judgment LLM. Escalating to user.',
  'no-verdict': 'pi-gate: Judgment LLM did not return a verdict. Escalating to user.',
};

const COLOR: Record<JudgeOutcome, ThemeColor> = {
  allowed: 'success',
  denied: 'error',
  'no-judge': 'dim',
  unavailable: 'warning',
  error: 'warning',
  'no-verdict': 'warning',
};

/** Data stored in each `pi-gate-verdict` custom entry. */
export interface VerdictEntryData {
  text: string;
  command: string;
  outcome: JudgeOutcome;
  details?: JudgeVerdictDetails;
  /** Underlying failure detail, shown when an error outcome entry is expanded. */
  error?: string;
}

/**
 * Register the TUI renderer for verdict entries. Collapsed entries show the
 * fixed verdict line; expanded entries add the judge's summary, affected
 * paths, reasoning, and the raw command.
 *
 * @param pi - Extension API used to register the entry renderer.
 */
export function registerVerdictRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<VerdictEntryData>(VERDICT_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;

    const box = new Box(0, 0);
    box.addChild(new Text(theme.fg(COLOR[data.outcome], data.text), 0, 0));

    if (expanded) {
      const d = data.details;
      if (d) {
        box.addChild(new Text(theme.fg('dim', `SUMMARY: ${d.summary}`), 1, 0));
        box.addChild(new Text(theme.fg('dim', `AFFECTED PATHS: ${d.affectedPaths}`), 1, 0));
        box.addChild(new Text(theme.fg('dim', `REASON: ${d.reason}`), 1, 0));
      }
      if (data.error) {
        box.addChild(new Text(theme.fg('warning', `ERROR: ${data.error}`), 1, 0));
      }
      box.addChild(new Text(theme.fg('dim', `COMMAND: ${data.command}`), 1, 0));
    }

    return box;
  });
}

/**
 * Append a verdict message to the chat transcript (never sent to the LLM).
 *
 * @param pi - Extension API used to append the custom entry.
 * @param outcome - Judge outcome selecting the fixed message text.
 * @param command - Raw bash command that was judged.
 * @param details - Parsed judge output, stored for the expanded renderer.
 * @param error - Underlying failure detail for error outcomes.
 */
export function logJudgeOutcome(
  pi: ExtensionAPI,
  outcome: JudgeOutcome,
  command: string,
  details?: JudgeVerdictDetails,
  error?: string,
): void {
  pi.appendEntry<VerdictEntryData>(VERDICT_ENTRY_TYPE, {
    text: MESSAGES[outcome],
    command,
    outcome,
    ...(details ? { details } : {}),
    ...(error ? { error } : {}),
  });
}
