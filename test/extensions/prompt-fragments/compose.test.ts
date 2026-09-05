import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { composePrompt } from '../../../extensions/prompt-fragments/compose.ts';

const fr = (name: string, prompt: string) => ({ name, prompt });

test('append pads block and message with a blank line', () => {
  strictEqual(
    composePrompt('do the thing', [fr('a', 'ctx A'), fr('b', 'ctx B')], 'append'),
    'do the thing\n\nctx A\n\nctx B',
  );
});

test('prepend puts fragments before the message', () => {
  strictEqual(composePrompt('msg', [fr('a', 'ctx')], 'prepend'), 'ctx\n\nmsg');
});

test('empty editor yields block only', () => {
  strictEqual(composePrompt('', [fr('a', 'ctx')], 'append'), 'ctx');
  strictEqual(composePrompt('   \n', [fr('a', 'ctx')], 'append'), 'ctx');
});

test('empty selection yields trimmed message', () => {
  strictEqual(composePrompt('  msg  ', [], 'append'), 'msg');
});

test('fragment whitespace is trimmed', () => {
  strictEqual(composePrompt('m', [fr('a', '  ctx\n')], 'append'), 'm\n\nctx');
});

test('empty fragments after trimming are dropped', () => {
  strictEqual(composePrompt('m', [fr('a', '  \n ')], 'append'), 'm');
});

test('multi-fragment block joins with blank lines in given order', () => {
  strictEqual(composePrompt('', [fr('a', 'A'), fr('b', 'B'), fr('c', 'C')], 'prepend'), 'A\n\nB\n\nC');
});
