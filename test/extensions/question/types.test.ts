import { deepStrictEqual, strictEqual } from 'node:assert';
import { test } from 'node:test';
import { answerToDetails, answerToText } from '../../../extensions/question/types.ts';

test('answerToDetails maps each answer variant', () => {
  deepStrictEqual(answerToDetails({ kind: 'option', index: 1, label: 'Beta' }), {
    kind: 'option',
    index: 1,
    label: 'Beta',
  });
  deepStrictEqual(answerToDetails({ kind: 'option', index: 0, label: 'Alpha', description: 'first' }), {
    kind: 'option',
    index: 0,
    label: 'Alpha',
    description: 'first',
  });
  deepStrictEqual(answerToDetails({ kind: 'custom', text: 'hi' }), { kind: 'custom', text: 'hi' });
  deepStrictEqual(answerToDetails(null), { kind: 'cancelled' });
});

test('answerToText returns a model-facing summary', () => {
  strictEqual(answerToText({ kind: 'option', index: 0, label: 'Alpha' }), 'Answer: 1. Alpha');
  strictEqual(answerToText({ kind: 'option', index: 2, label: 'Gamma' }), 'Answer: 3. Gamma');
  strictEqual(answerToText({ kind: 'custom', text: 'my text' }), 'Answer: my text');
  strictEqual(answerToText({ kind: 'cancelled' }), 'The user declined to answer.');
});
