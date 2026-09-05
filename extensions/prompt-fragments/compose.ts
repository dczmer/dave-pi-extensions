import type { PromptFragment } from './fragments.ts';

/** Insertion mode for fragments relative to the current editor text. */
export type FragmentMode = 'prepend' | 'append';

/**
 * Assemble the new editor text. Every adjacent pair (fragment-fragment,
 * fragment-message) is separated by exactly one blank line.
 */
export function composePrompt(currentText: string, fragments: PromptFragment[], mode: FragmentMode): string {
  const block = fragments
    .map((f) => f.prompt.trim())
    .filter((p) => p !== '')
    .join('\n\n');
  const message = currentText.trim();
  if (block === '') return message;
  if (message === '') return block;
  return mode === 'prepend' ? `${block}\n\n${message}` : `${message}\n\n${block}`;
}
