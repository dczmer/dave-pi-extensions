import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { contentText, parseSession, toDisplayBlocks } from '../../src/session-viewer/format.ts';
import { withTempDir } from '../utils/temp-dir.ts';

let counter = 0;

/** Build a SessionEntry of the given type with a fresh linked id/parentId. */
function entry(type: string, extra: Record<string, unknown> = {}): SessionEntry {
  counter += 1;
  return {
    type,
    id: `id${counter}`,
    parentId: counter === 1 ? null : `id${counter - 1}`,
    timestamp: '2026-09-30T14:05:00.000Z',
    ...extra,
  } as unknown as SessionEntry;
}

/** A minimal zero-cost Usage block for assistant messages. */
function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1000 };
}

function assistantMessage(text: string, toolCallId?: string): AssistantMessage {
  const content: (TextContent | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> })[] =
    [{ type: 'text', text }];
  if (toolCallId) {
    content.push({ type: 'toolCall', id: toolCallId, name: 'bash', arguments: { command: 'ls' } });
  }
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: zeroUsage(),
    stopReason: 'stop',
    timestamp: 1001,
  };
}

function toolResultMessage(toolCallId: string, text: string, isError: boolean): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1002,
  };
}

test('contentText joins text blocks and marks images', () => {
  assert.strictEqual(
    contentText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'ab',
  );
  assert.strictEqual(
    contentText([
      { type: 'text', text: 'see' },
      { type: 'image', data: 'x', mimeType: 'image/png' },
    ]),
    'see[image]',
  );
  assert.strictEqual(contentText([]), '');
});

test('parseSession reads a session file and indexes tool results', () => {
  withTempDir('sv-format-', (dir) => {
    const path = join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'abc12345',
        timestamp: '2026-09-30T14:05:00.000Z',
        cwd: '/tmp/proj',
      }),
      JSON.stringify(entry('model_change', { provider: 'anthropic', modelId: 'claude-test' })),
      JSON.stringify(entry('message', { message: userMessage('hello') })),
      JSON.stringify(entry('message', { message: assistantMessage('let me look', 'tc1') })),
      JSON.stringify(entry('message', { message: toolResultMessage('tc1', 'file.txt', false) })),
      'not json at all',
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const parsed = parseSession(path);
    assert.ok(parsed);
    assert.strictEqual(parsed.header.id, 'abc12345');
    assert.strictEqual(parsed.header.cwd, '/tmp/proj');
    // The malformed last line is skipped by pi's parser.
    assert.strictEqual(parsed.entries.length, 4);
    const result = parsed.toolResults.get('tc1');
    assert.ok(result);
    assert.strictEqual(result.toolName, 'bash');
    assert.strictEqual(result.text, 'file.txt');
    assert.strictEqual(result.isError, false);
  });
});

test('parseSession rejects files without a session header', () => {
  withTempDir('sv-format-', (dir) => {
    const path = join(dir, 'noheader.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'x', timestamp: 1 } }) + '\n',
    );
    assert.strictEqual(parseSession(path), null);
  });
});

test('parseSession returns null for missing files', () => {
  assert.strictEqual(parseSession('/nonexistent/session.jsonl'), null);
});

test('toDisplayBlocks emits blocks in file order with consumed tool results paired away', () => {
  counter = 0;
  const entries = [
    entry('message', { message: userMessage('hi') }),
    entry('message', { message: assistantMessage('checking', 'tc1') }),
    entry('message', { message: toolResultMessage('tc1', 'out', false) }),
  ];
  const blocks = toDisplayBlocks(entries);
  assert.deepStrictEqual(
    blocks.map((b) => b.kind),
    ['user', 'assistant'],
  );
});

test('toDisplayBlocks renders orphan tool results on their own', () => {
  counter = 0;
  const entries = [entry('message', { message: toolResultMessage('tc-orphan', 'orphan out', true) })];
  const blocks = toDisplayBlocks(entries);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0]!.kind, 'orphan_result');
  if (blocks[0]!.kind === 'orphan_result') {
    assert.strictEqual(blocks[0]!.result.text, 'orphan out');
    assert.strictEqual(blocks[0]!.result.isError, true);
  }
});

test('toDisplayBlocks renders meta entries in the documented formats', () => {
  counter = 0;
  const entries = [
    entry('model_change', { provider: 'anthropic', modelId: 'claude-test' }),
    entry('thinking_level_change', { thinkingLevel: 'high' }),
    entry('label', { targetId: 'id1', label: 'checkpoint' }),
    entry('compaction', { summary: 'summarized', firstKeptEntryId: 'id1', tokensBefore: 1234 }),
    entry('branch_summary', { fromId: 'id1', summary: 'branch note' }),
    entry('custom_message', { customType: 'note', content: 'a custom note', display: true }),
    entry('custom_message', { customType: 'note', content: 'hidden', display: false }),
  ];
  const blocks = toDisplayBlocks(entries);
  const meta = blocks.filter((b) => b.kind === 'meta');
  assert.deepStrictEqual(
    meta.map((b) => (b.kind === 'meta' ? b.text : '')),
    [
      '◆ Model: anthropic/claude-test',
      '◆ Thinking: high',
      '◆ Label: checkpoint',
      '◆ Compaction (1234 tokens before): summarized',
      '◆ Branch: branch note',
      'a custom note',
    ],
  );
  // detail flags: compaction and custom messages always render, the rest are detail.
  assert.deepStrictEqual(
    meta.map((b) => (b.kind === 'meta' ? b.detail : false)),
    [true, true, true, false, true, false],
  );
});

test('toDisplayBlocks skips system messages and label entries without a label', () => {
  counter = 0;
  const entries = [
    entry('message', { message: { role: 'system', content: 'system text', timestamp: 1 } }),
    entry('label', { targetId: 'id1', label: undefined }),
  ];
  assert.strictEqual(toDisplayBlocks(entries).length, 0);
});
