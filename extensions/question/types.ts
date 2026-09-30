import { Type, type Static } from 'typebox';

/** A selectable option presented to the user. */
export interface QuestionOption {
  /** Short label shown in the menu. */
  label: string;
  /** Optional muted description rendered under the label. */
  description?: string;
}

/** Model-facing parameter schema for the `question` tool. */
export const questionSchema = Type.Object({
  title: Type.String({ description: 'Short title for the question, shown bold at the top.' }),
  description: Type.Optional(Type.String({ description: 'Optional extra context shown under the title.' })),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: 'Short label for this option.' }),
      description: Type.Optional(Type.String({ description: 'Optional muted description for this option.' })),
    }),
    { minItems: 1, description: 'Menu options to present (at least one).' },
  ),
  allowOther: Type.Optional(
    Type.Boolean({
      description: 'Whether to show a free-form "Type a response" option. Defaults to true (always shown).',
    }),
  ),
});

/** Static (runtime) type of the question tool's parameters. */
export type QuestionParams = Static<typeof questionSchema>;

/**
 * The answer the user gave. A discriminated union; `null` means the user cancelled
 * (pressed Esc). This is the value handed to the `done` callback of the UI.
 */
export type QuestionAnswer =
  | { kind: 'option'; index: number; label: string; description?: string }
  | { kind: 'custom'; text: string }
  | null;

/** The option-answer member of {@link QuestionAnswer}, as its own named type. */
export type OptionAnswer = Extract<QuestionAnswer, { kind: 'option' }>;

/** Structured details attached to the tool result, used for rendering and logs. */
export type QuestionDetails =
  | { kind: 'option'; index: number; label: string; description?: string }
  | { kind: 'custom'; text: string }
  | { kind: 'cancelled' };

/**
 * Convert a raw user answer (possibly `null`) into result details.
 *
 * @param answer - The answer produced by the UI, or `null` if the user cancelled.
 * @returns The structured details to attach to the tool result.
 */
export function answerToDetails(answer: QuestionAnswer): QuestionDetails {
  if (answer === null) {
    return { kind: 'cancelled' };
  }
  if (answer.kind === 'option') {
    const base: QuestionDetails = { kind: 'option', index: answer.index, label: answer.label };
    if (answer.description !== undefined) {
      (base as { description?: string }).description = answer.description;
    }
    return base;
  }
  return { kind: 'custom', text: answer.text };
}

/**
 * Build the human/model-facing one-line text for a result.
 *
 * @param details - The structured result details.
 * @returns A single-line summary of the user's answer (or their refusal).
 */
export function answerToText(details: QuestionDetails): string {
  switch (details.kind) {
    case 'option':
      return `Answer: ${details.index + 1}. ${details.label}`;
    case 'custom':
      return `Answer: ${details.text}`;
    case 'cancelled':
      return 'The user declined to answer.';
  }
}
