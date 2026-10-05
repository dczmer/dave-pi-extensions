import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { createUIContext } from '../../utils/pi-context.ts';
import { formatFleetLines } from '../../../extensions/subagent/widget.ts';
import { zeroUsage, type SubagentRun } from '../../../extensions/subagent/runner.ts';

// Identity theme: fg/bg/bold all return their input unchanged.
const theme = createUIContext().theme;

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agent: 'worker',
    task: 't',
    statusLine: '',
    messages: [],
    usage: zeroUsage(),
    exitCode: null,
    ...overrides,
  };
}

function deepStrictEqualLines(actual: string[], expected: string[]): void {
  strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) strictEqual(actual[i], expected[i]);
}

test('empty run list renders nothing', () => {
  deepStrictEqualLines(formatFleetLines([], theme), []);
});

test('running run shows the status line under the header', () => {
  const lines = formatFleetLines([makeRun({ statusLine: 'bash: npm test' })], theme);
  strictEqual(lines[0], 'subagents 0/1 done');
  strictEqual(lines[1], '⏳ worker bash: npm test');
});

test('running run without a status line shows a placeholder', () => {
  const lines = formatFleetLines([makeRun()], theme);
  ok(lines[1]!.endsWith('(starting...)'));
});

test('completed run shows done with usage', () => {
  const usage = zeroUsage();
  usage.turns = 2;
  usage.input = 1200;
  const lines = formatFleetLines([makeRun({ exitCode: 0, usage })], theme);
  strictEqual(lines[0], 'subagents 1/1 done');
  strictEqual(lines[1], '✓ worker done · 2 turns ↑1.2k');
});

test('failed run shows the error message', () => {
  const lines = formatFleetLines([makeRun({ exitCode: 1, errorMessage: 'boom' })], theme);
  strictEqual(lines[0], 'subagents 1/1 done');
  strictEqual(lines[1], '✗ worker boom');
});

test('mixed fleet: one line per run in order', () => {
  const lines = formatFleetLines(
    [
      makeRun({ agent: 'a', exitCode: 0 }),
      makeRun({ agent: 'b', statusLine: 'reading...' }),
      makeRun({ agent: 'c', exitCode: 1, errorMessage: 'nope' }),
    ],
    theme,
  );
  strictEqual(lines[0], 'subagents 2/3 done');
  strictEqual(lines[1], '✓ a done');
  strictEqual(lines[2], '⏳ b reading...');
  strictEqual(lines[3], '✗ c nope');
});
