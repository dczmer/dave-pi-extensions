import type { PromptFragment } from './fragments.ts';

/** Insertion mode for fragments relative to the current editor text. */
export type FragmentMode = 'prepend' | 'append';

/**
 * Remove a leading slash-command invocation from editor text. Drops the
 * command token and any same-line arguments, preserving content on later
 * lines. Returns the input unchanged when it does not start with the
 * given command.
 *
 * Needed because callers such as the leader-key extension set the editor
 * text to the command and invoke onSubmit directly, bypassing the normal
 * submit path that clears the editor.
 */
export function stripCommandInvocation(text: string, command: string): string {
  const start = text.trimStart();
  const invocation = `/${command}`;
  if (!start.startsWith(invocation)) return text;
  let afterName = start.slice(invocation.length);
  // Drop an optional pi collision suffix (":1", ":2", ...).
  const suffix = /^:\d+/.exec(afterName);
  if (suffix) afterName = afterName.slice(suffix[0].length);
  // Only a whole-token match counts (end, whitespace, or newline).
  if (afterName !== '' && !/^\s/.test(afterName)) return text;
  const newlineIndex = afterName.search(/\n/);
  return newlineIndex === -1 ? '' : afterName.slice(newlineIndex + 1);
}

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
