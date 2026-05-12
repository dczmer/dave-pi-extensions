/**
 * Context Usage Progress Bar Extension
 *
 * Adds a visual progress bar to the footer showing context window usage
 * with percentage and max size. The plan-mode indicator appears directly
 * on the left of the progress bar. Other extension statuses go on the
 * right before the model info.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';

// Progress bar characters (8 steps for smooth bar)
const BAR_CHARS = ['░', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;

const YELLOW_THRESHOLD = 80_000;
const RED_THRESHOLD = 120_000;

/** Render a terminal progress bar with border and visible empty track. */
export function renderProgressBar(used: number, max: number, width: number, theme: any): string {
  if (width < 1) return '';

  const ratio = Math.min(used / max, 1);
  const filledWidth = ratio * width;
  const filledFull = Math.floor(filledWidth);
  const partial = Math.floor((filledWidth - filledFull) * 8);

  let color: string;
  if (used >= RED_THRESHOLD) color = 'error';
  else if (used >= YELLOW_THRESHOLD) color = 'warning';
  else color = 'success';

  let bar = filledFull > 0 ? theme.fg(color, '█'.repeat(filledFull)) : '';
  if (filledFull < width) {
    const partialChar = partial === 0 ? theme.fg('dim', BAR_CHARS[0]) : theme.fg(color, BAR_CHARS[partial]);
    bar += partialChar;
    bar += theme.fg('dim', BAR_CHARS[0].repeat(width - filledFull - 1));
  }

  return theme.fg('border', '[') + bar + theme.fg('border', ']');
}

/** Format a token count into a compact human-readable string. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function installFooter(ctx: ExtensionContext) {
  ctx.ui.setFooter((tui, theme, footerData) => {
    footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        const usage = ctx.getContextUsage();
        const model = ctx.model;

        // Pull plan-mode status to the left
        const allStatuses = footerData.getExtensionStatuses();
        const planStatus = allStatuses.get('plan-mode');
        const otherStatuses = [...allStatuses.entries()].filter(([k]) => k !== 'plan-mode').map(([, v]) => v);

        // --- Left side: plan status + context bar ---
        let contextSection = '';
        if (usage && model?.contextWindow) {
          const used = usage.tokens ?? 0;
          const max = model.contextWindow;
          const percent = Math.round((used / max) * 100);

          const barWidth = Math.min(20, Math.floor(width * 0.15));
          const bar = renderProgressBar(used, max, barWidth, theme);

          contextSection = `${bar} ${theme.fg('dim', `${percent}%`)} ${theme.fg(
            'muted',
            `(${formatTokens(used)}/${formatTokens(max)})`,
          )}`;
        }

        if (planStatus) {
          contextSection = planStatus + (contextSection ? '  ' + contextSection : '');
        }

        // --- Right side: other extension statuses + model info ---
        const statusPrefix = otherStatuses.length > 0 ? otherStatuses.join(' ') + '  ' : '';

        const branch = footerData.getGitBranch();
        const modelId = model?.id || 'no-model';
        const provider = model?.provider || 'unknown';
        const right = statusPrefix + theme.fg('dim', `${provider}/${modelId}${branch ? ` (${branch})` : ''}`);

        // Calculate spacing
        const leftWidth = visibleWidth(contextSection);
        const rightWidth = visibleWidth(right);
        const padWidth = Math.max(1, width - leftWidth - rightWidth);
        const pad = ' '.repeat(padWidth);

        return [truncateToWidth(contextSection + pad + right, width)];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.registerCommand('context-bar', {
    description: 'Toggle context usage progress bar',
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        installFooter(ctx);
        ctx.ui.notify('Context usage bar enabled', 'info');
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify('Context usage bar disabled', 'info');
      }
    },
  });

  // Auto-enable on session start
  pi.on('session_start', async (_event, ctx) => {
    if (enabled) {
      installFooter(ctx);
    }
  });

  // Update on model changes
  pi.on('model_select', async () => {
    // Footer re-renders automatically from context usage update
  });
}
