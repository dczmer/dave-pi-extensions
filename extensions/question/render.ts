import { Text, type Component } from '@earendil-works/pi-tui';
import type { AgentToolResult, Theme, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { TYPE_RESPONSE_LABEL } from './component.ts';
import type { QuestionDetails, QuestionParams } from './types.ts';

/**
 * Render the question tool call as a single compact line: a bold `question:` prefix,
 * the title, and a dim bracketed list of option labels (including the free-form entry
 * when enabled). The full prompt content already appears in the interactive dialog,
 * so the transcript only records a short reminder of what was asked.
 *
 * Note: `Text` pads its content with one blank line above and below by default, which
 * would blank-separate every line of a transcript summary — pass `0` padding.
 *
 * @param params - The tool call arguments.
 * @param theme - The active pi theme.
 * @returns A pi-tui component for the call view.
 */
export function renderQuestionCall(params: QuestionParams, theme: Theme): Component {
  const labels = params.options.map((option) => option.label);
  if (params.allowOther !== false) {
    labels.push(TYPE_RESPONSE_LABEL);
  }
  const line =
    `${theme.bold(theme.fg('accent', 'question:'))} ${theme.fg('text', params.title)}` +
    theme.fg('dim', `  [${labels.join(' · ')}]`);
  return new Text(line, 0, 0);
}

/**
 * Render the question tool result: a green check for an answer (selected option or
 * free-form text) or an amber warning when the user cancelled.
 *
 * @param result - The tool result carrying the structured details.
 * @param options - Render options (expanded/partial state).
 * @param theme - The active pi theme.
 * @returns A pi-tui component for the result view.
 */
export function renderQuestionResult(
  result: AgentToolResult<QuestionDetails>,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = result.details;
  let line: string;
  if (details.kind === 'option') {
    line = `${theme.fg('success', '✓')} ${details.index + 1}. ${details.label}`;
  } else if (details.kind === 'custom') {
    line = `${theme.fg('success', '✓')} (typed) ${details.text}`;
  } else {
    line = `${theme.fg('warning', '⚠')} Cancelled`;
  }
  return new Text(line, 0, 0);
}
