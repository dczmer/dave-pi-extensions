import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { test, mock } from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { createQuestionExtension, QUESTION_TOOL_NAME } from '../../../extensions/question/index.ts';
import { TYPE_RESPONSE_LABEL } from '../../../extensions/question/component.ts';
import { renderQuestionCall, renderQuestionResult } from '../../../extensions/question/render.ts';
import type { QuestionAnswer, QuestionDetails, QuestionParams } from '../../../extensions/question/types.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';
import { createUIContext } from '../../utils/pi-context.ts';

/** Identity theme for renderer smoke tests. */
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** A tool result as the question tool returns it. */
interface ToolResultLike {
  content: unknown[];
  details: QuestionDetails;
  isError?: boolean;
}

/** Build a UI context whose `custom` resolves with a chosen answer. */
function uiWithAnswer(answer: QuestionAnswer) {
  const ui = createUIContext();
  ui.custom = mock.fn(async () => answer) as unknown as typeof ui.custom;
  return ui;
}

/** Create a temp working directory and register cleanup on the test. */
function withTempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(`${process.cwd()}/.pi-question-test-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('question extension registers the question tool', async (t) => {
  const dir = withTempDir(t);
  const harness = await createPiTestHarness(createQuestionExtension, dir);
  assert.ok(harness.listRegisteredTools().includes(QUESTION_TOOL_NAME));
});

test('execute resolves a cancelled result when the UI produces no answer', async (t) => {
  const dir = withTempDir(t);
  const harness = await createPiTestHarness(createQuestionExtension, dir);
  const result = (await harness.tool(QUESTION_TOOL_NAME).execute(
    { title: 'Pick a color', options: [{ label: 'Alpha' }] },
    // The harness's default ui.custom resolves undefined -> cancelled.
    { ui: createUIContext() },
  )) as unknown as ToolResultLike;
  assert.deepStrictEqual(result.details, { kind: 'cancelled' });
});

test('execute surfaces a selected option', async (t) => {
  const dir = withTempDir(t);
  const harness = await createPiTestHarness(createQuestionExtension, dir);
  const result = (await harness
    .tool(QUESTION_TOOL_NAME)
    .execute(
      { title: 'Pick a color', options: [{ label: 'Alpha', description: 'first' }] },
      { ui: uiWithAnswer({ kind: 'option', index: 0, label: 'Alpha', description: 'first' }) },
    )) as unknown as ToolResultLike;
  assert.deepStrictEqual(result.details, { kind: 'option', index: 0, label: 'Alpha', description: 'first' });
});

test('execute surfaces a free-form answer', async (t) => {
  const dir = withTempDir(t);
  const harness = await createPiTestHarness(createQuestionExtension, dir);
  const result = (await harness
    .tool(QUESTION_TOOL_NAME)
    .execute(
      { title: 'Pick a color', options: [{ label: 'Alpha' }] },
      { ui: uiWithAnswer({ kind: 'custom', text: 'my own answer' }) },
    )) as unknown as ToolResultLike;
  assert.deepStrictEqual(result.details, { kind: 'custom', text: 'my own answer' });
});

test('execute rejects when there is no interactive TUI', async (t) => {
  const dir = withTempDir(t);
  const harness = await createPiTestHarness(createQuestionExtension, dir);
  await assert.rejects(
    harness
      .tool(QUESTION_TOOL_NAME)
      .execute({ title: 'Pick a color', options: [{ label: 'Alpha' }] }, { ui: createUIContext(), mode: 'rpc' }),
    /interactive TUI/,
  );
});

test('renderCall renders a compact one-line summary of the question', () => {
  const component = renderQuestionCall(
    { title: 'Pick a color', options: [{ label: 'Alpha', description: 'first' }] } as QuestionParams,
    fakeTheme,
  );
  const lines = component.render(80);
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  const out = lines.join('\n');
  assert.ok(out.includes('Pick a color'), out);
  assert.ok(out.includes('Alpha'), out);
  assert.ok(out.includes(TYPE_RESPONSE_LABEL), out);
  assert.ok(!out.includes('first'), out);
});

test('renderResult renders selected, free-form, and cancelled results', () => {
  const selected = renderQuestionResult(
    { content: [], details: { kind: 'option', index: 0, label: 'Alpha' } },
    { expanded: true, isPartial: false },
    fakeTheme,
  );
  assert.ok(selected.render(80).join('\n').includes('Alpha'), selected.render(80).join('\n'));

  const custom = renderQuestionResult(
    { content: [], details: { kind: 'custom', text: 'my own answer' } },
    { expanded: true, isPartial: false },
    fakeTheme,
  );
  assert.ok(custom.render(80).join('\n').includes('my own answer'), custom.render(80).join('\n'));

  const cancelled = renderQuestionResult(
    { content: [], details: { kind: 'cancelled' } },
    { expanded: true, isPartial: false },
    fakeTheme,
  );
  assert.ok(cancelled.render(80).join('\n').includes('Cancelled'), cancelled.render(80).join('\n'));
});
