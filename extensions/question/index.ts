import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { answerToDetails, answerToText, questionSchema, type QuestionAnswer, type QuestionDetails } from './types.ts';
import { createQuestionComponent, type QuestionComponentOptions } from './component.ts';
import { renderQuestionCall, renderQuestionResult } from './render.ts';

/** Registered name of the question tool. */
export const QUESTION_TOOL_NAME = 'question';

/**
 * Build the `question` tool extension: a single focused tool that asks the user one
 * question and returns their answer (a chosen option, free-form text, or a cancel).
 *
 * @param pi - The pi extension API.
 */
export const createQuestionExtension = (pi: ExtensionAPI): void => {
  pi.registerTool<typeof questionSchema, QuestionDetails>({
    name: QUESTION_TOOL_NAME,
    label: 'Question',
    description: [
      'Ask the user a question and get their answer.',
      'Show a short title, optional context, a list of options (each with an optional',
      'description), and a free-form "Type a response" option.',
      'Use it when you need the user to choose between options or to provide',
      'information only they know. If the user cancels, the tool reports that they',
      'declined to answer so you can adapt.',
    ].join(' '),
    parameters: questionSchema,
    executionMode: 'sequential',
    promptGuidelines: [
      'When you need the user to choose between options or provide specific information, call the `question` tool with a concise title, clear options with short descriptions, and keep the free-form "Type a response" option enabled so the user is never forced into a wrong choice.',
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== 'tui') {
        throw new Error(
          'The question tool needs an interactive TUI session; it cannot be used in rpc/json/print mode.',
        );
      }
      const details = answerToDetails(
        await askUser(ctx, params.title, params.description, params.options, params.allowOther ?? true),
      );
      return {
        content: [{ type: 'text' as const, text: answerToText(details) }],
        details,
      };
    },
    renderCall: (args, theme) => renderQuestionCall(args, theme),
    renderResult: (result, options, theme) => renderQuestionResult(result, options, theme),
  });
};

/**
 * Present the question to the user via a focused `ctx.ui.custom` component and await
 * their answer.
 *
 * @param ctx - The extension command context (must have a TUI).
 * @param title - The bold question title.
 * @param description - Optional context under the title.
 * @param options - The selectable options.
 * @param allowOther - Whether to show the free-form "Type a response" option.
 * @returns The user's answer, or `null` if they cancelled.
 */
async function askUser(
  ctx: ExtensionContext,
  title: string,
  description: string | undefined,
  options: { label: string; description?: string }[],
  allowOther: boolean,
): Promise<QuestionAnswer> {
  const answer = await ctx.ui.custom<QuestionAnswer>((tui, theme, _keybindings, done) => {
    const componentOptions: QuestionComponentOptions = { title, options, allowOther, theme, tui, done };
    if (description !== undefined) {
      componentOptions.description = description;
    }
    return createQuestionComponent(componentOptions);
  });
  return answer ?? null;
}

export default createQuestionExtension;
