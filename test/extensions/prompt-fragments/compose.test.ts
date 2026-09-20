import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { composePrompt, stripCommandInvocation } from '../../../extensions/prompt-fragments/compose.ts';

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

test('stripCommandInvocation removes the bare command', () => {
  strictEqual(stripCommandInvocation('/fragments-append', 'fragments-append'), '');
});

test('stripCommandInvocation removes the command with arguments', () => {
  strictEqual(stripCommandInvocation('/fragments-append foo bar', 'fragments-append'), '');
});

test('stripCommandInvocation tolerates surrounding whitespace', () => {
  strictEqual(stripCommandInvocation('  /fragments-prepend  ', 'fragments-prepend'), '');
});

test('stripCommandInvocation preserves text on later lines', () => {
  strictEqual(stripCommandInvocation('/fragments-append\nkeep me', 'fragments-append'), 'keep me');
});

test('stripCommandInvocation leaves unrelated text untouched', () => {
  strictEqual(stripCommandInvocation('hello world', 'fragments-append'), 'hello world');
  strictEqual(stripCommandInvocation('/other-command', 'fragments-append'), '/other-command');
});

test('stripCommandInvocation requires a whole-token match', () => {
  strictEqual(stripCommandInvocation('/fragments-appendage', 'fragments-append'), '/fragments-appendage');
});

test('stripCommandInvocation drops a pi collision suffix', () => {
  strictEqual(stripCommandInvocation('/fragments-append:2', 'fragments-append'), '');
});
