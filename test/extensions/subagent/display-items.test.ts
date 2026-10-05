import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { createUIContext } from '../../utils/pi-context.ts';
import { formatToolCall, getDisplayItems } from '../../../extensions/subagent/display-items.ts';

// Identity theme: fg/bg/bold all return their input unchanged.
const theme = createUIContext().theme;

/** Build a complete 0.85.1 AssistantMessage with the given content parts. */
function assistantMsg(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

test('getDisplayItems flattens assistant text and tool calls in order', () => {
  const messages: Message[] = [
    { role: 'user', content: 'do the thing', timestamp: Date.now() },
    assistantMsg([
      { type: 'text', text: 'first' },
      { type: 'toolCall', id: '1', name: 'bash', arguments: { command: 'npm test' } },
    ]),
    {
      role: 'toolResult',
      toolCallId: '1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'test output' }],
      isError: false,
      timestamp: Date.now(),
    },
    assistantMsg([
      { type: 'toolCall', id: '2', name: 'read', arguments: { path: '/a.ts' } },
      { type: 'text', text: 'second' },
    ]),
  ];
  deepStrictEqualLoose(getDisplayItems(messages), [
    { type: 'text', text: 'first' },
    { type: 'toolCall', name: 'bash', args: { command: 'npm test' } },
    { type: 'toolCall', name: 'read', args: { path: '/a.ts' } },
    { type: 'text', text: 'second' },
  ]);
});

/** deepStrictEqual without the strict prototype check fighting literal types. */
function deepStrictEqualLoose(actual: unknown, expected: unknown): void {
  strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

test('getDisplayItems returns empty for no assistant messages', () => {
  const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: Date.now() }];
  strictEqual(getDisplayItems(messages).length, 0);
});

test('formatToolCall bash prefixes $ and clips at 60 chars', () => {
  strictEqual(formatToolCall('bash', { command: 'npm test' }, theme), '$ npm test');
  const long = 'x'.repeat(100);
  const rendered = formatToolCall('bash', { command: long }, theme);
  strictEqual(rendered, `$ ${'x'.repeat(60)}...`);
});

test('formatToolCall read renders path with optional line range', () => {
  strictEqual(formatToolCall('read', { path: '/src/foo.ts' }, theme), 'read /src/foo.ts');
  strictEqual(formatToolCall('read', { path: '/src/foo.ts', offset: 10, limit: 5 }, theme), 'read /src/foo.ts:10-14');
  strictEqual(formatToolCall('read', { path: '/src/foo.ts', offset: 10 }, theme), 'read /src/foo.ts:10');
});

test('formatToolCall read shortens home paths to ~', () => {
  const homeFile = path.join(os.homedir(), 'src', 'foo.ts');
  strictEqual(formatToolCall('read', { path: homeFile }, theme), 'read ~/src/foo.ts');
});

test('formatToolCall write shows line count only when more than one line', () => {
  strictEqual(formatToolCall('write', { path: '/a.ts', content: 'one' }, theme), 'write /a.ts');
  strictEqual(formatToolCall('write', { path: '/a.ts', content: 'one\ntwo\nthree' }, theme), 'write /a.ts (3 lines)');
});

test('formatToolCall edit, ls, find, grep', () => {
  strictEqual(formatToolCall('edit', { path: '/a.ts' }, theme), 'edit /a.ts');
  strictEqual(formatToolCall('ls', { path: '/src' }, theme), 'ls /src');
  strictEqual(formatToolCall('find', { pattern: '*.ts', path: '/src' }, theme), 'find *.ts in /src');
  strictEqual(formatToolCall('grep', { pattern: 'foo', path: '/src' }, theme), 'grep /foo/ in /src');
});

test('formatToolCall unknown tool renders clipped JSON', () => {
  const rendered = formatToolCall('mystery', { some: 'arg' }, theme);
  ok(rendered.startsWith('mystery '));
  ok(rendered.includes('{"some":"arg"}'));
  const long = formatToolCall('mystery', { data: 'x'.repeat(100) }, theme);
  ok(long.endsWith('...'));
  ok(long.length < 'mystery '.length + 100);
});

test('formatToolCall defaults fill in for missing args', () => {
  strictEqual(formatToolCall('bash', {}, theme), '$ ...');
  strictEqual(formatToolCall('read', {}, theme), 'read ...');
  strictEqual(formatToolCall('ls', {}, theme), 'ls .');
  strictEqual(formatToolCall('find', {}, theme), 'find * in .');
});
