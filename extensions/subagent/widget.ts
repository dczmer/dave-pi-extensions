/**
 * Fleet widget: a below-editor panel listing every active subagent run.
 * Rendered as plain themed string lines (RPC-mode widgets only support
 * string arrays, and string content keeps this renderer trivially testable).
 */
import type { Theme } from '@earendil-works/pi-coding-agent';
import { formatUsageStats } from './render.ts';
import { isFailedRun, type SubagentRun } from './runner.ts';

/** Widget key used with ctx.ui.setWidget. */
export const FLEET_WIDGET_KEY = 'subagent';

function icon(run: SubagentRun): string {
  if (run.exitCode === null) return '⏳';
  return isFailedRun(run) ? '✗' : '✓';
}

/** One line per run plus a header; empty array when there is nothing to show. */
export function formatFleetLines(runs: SubagentRun[], theme: Theme): string[] {
  if (runs.length === 0) return [];
  const done = runs.filter((r) => r.exitCode !== null).length;
  const lines = [theme.fg('toolTitle', theme.bold('subagents ')) + theme.fg('accent', `${done}/${runs.length} done`)];
  for (const run of runs) {
    let line = `${icon(run)} ${theme.fg('toolTitle', run.agent)}`;
    if (run.exitCode === null) {
      line += theme.fg('dim', ` ${run.statusLine || '(starting...)'}`);
    } else if (isFailedRun(run)) {
      line += theme.fg('error', ` ${run.errorMessage ?? 'failed'}`);
    } else {
      const usage = formatUsageStats(run.usage);
      line += theme.fg('dim', usage ? ` done · ${usage}` : ' done');
    }
    lines.push(line);
  }
  return lines;
}
