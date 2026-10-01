import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ParsedSession } from '../../src/session-viewer/format.ts';
import {
  aggregateUsage,
  clearTranscriptCache,
  getRenderedTranscript,
  renderTranscript,
} from '../../src/session-viewer/transcript.ts';
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

/** A zero-cost Usage block. */
function usage(input: number, output: number, total: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function assistantMessage(text: string, toolCallId?: string, costTotal = 0): AssistantMessage {
  const content: AssistantMessage['content'] = [{ type: 'text', text }];
  if (toolCallId) {
    content.push({ type: 'toolCall', id: toolCallId, name: 'bash', arguments: { command: 'ls' } });
  }
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: usage(10, 20, costTotal),
    stopReason: 'stop',
    timestamp: 1001,
  };
}

/** A small linear session: model change, user message, assistant tool call, result. */
function makeSession(): ParsedSession {
  counter = 0;
  const entries: SessionEntry[] = [
    entry('model_change', { provider: 'anthropic', modelId: 'claude-test' }),
    entry('message', { message: { role: 'user', content: 'hello there', timestamp: 1000 } }),
    entry('message', { message: assistantMessage('checking', 'tc1') }),
    entry('message', {
      message: {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file listing output' }],
        isError: false,
        timestamp: 1002,
      },
    }),
  ];
  return {
    header: { type: 'session', version: 3, id: 'sess1234', timestamp: '2026-09-30T14:05:00.000Z', cwd: '/tmp/proj' },
    entries,
    toolResults: new Map([['tc1', { toolName: 'bash', text: 'file listing output', isError: false }]]),
  };
}

/** Identity theme: styles are no-ops so rendered lines can be asserted as plain text. */
const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as import('@earendil-works/pi-coding-agent').Theme;

test('renderTranscript renders header, blocks, and usage footer', () => {
  const lines = renderTranscript(makeSession(), identityTheme, 40, true);
  const header = lines[0] ?? '';
  assert.ok(header.includes('sess1234'), `header: ${header}`);
  assert.ok(header.includes('/tmp/proj'), `header: ${header}`);
  assert.ok(header.includes('2026-09-30 14:05'), `header: ${header}`);
  assert.ok(lines.some((l) => l.includes('▸ you')));
  assert.ok(lines.some((l) => l.includes('hello there')));
  assert.ok(lines.some((l) => l.includes('◂ claude-test')));
  assert.ok(lines.some((l) => l.includes('⚙ bash')));
  assert.ok(lines.some((l) => l.includes('file listing output')));
  assert.ok(lines.some((l) => l.startsWith('tokens:')));
});

test('renderTranscript toggles detail meta entries with showMeta', () => {
  const withMeta = renderTranscript(makeSession(), identityTheme, 40, true);
  const withoutMeta = renderTranscript(makeSession(), identityTheme, 40, false);
  assert.ok(withMeta.some((l) => l.includes('◆ Model: anthropic/claude-test')));
  assert.ok(!withoutMeta.some((l) => l.includes('◆ Model: anthropic/claude-test')));
  // Content blocks are unaffected by the toggle.
  assert.ok(withoutMeta.some((l) => l.includes('hello there')));
});

test('renderTranscript elides long tool output', () => {
  const session = makeSession();
  const manyLines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  session.toolResults.set('tc1', { toolName: 'bash', text: manyLines, isError: false });
  const lines = renderTranscript(session, identityTheme, 40, true);
  assert.ok(lines.some((l) => l.includes('… 50 more lines')));
  assert.strictEqual(lines.filter((l) => l.startsWith('  line ')).length, 200);
});

test('renderTranscript renders error results and missing results distinctly', () => {
  const errorSession = makeSession();
  errorSession.toolResults.set('tc1', { toolName: 'bash', text: 'boom', isError: true });
  const errorLines = renderTranscript(errorSession, identityTheme, 40, true);
  assert.ok(errorLines.some((l) => l === '  boom'));

  const noResultSession = makeSession();
  noResultSession.toolResults.delete('tc1');
  const noResultLines = renderTranscript(noResultSession, identityTheme, 40, true);
  assert.ok(noResultLines.some((l) => l.includes('(no result)')));
});

test('renderTranscript renders orphan tool results', () => {
  const session = makeSession();
  // Drop the assistant entry so the result is orphaned.
  session.entries = session.entries.filter((e) => !(e.type === 'message' && e.message.role === 'assistant'));
  const lines = renderTranscript(session, identityTheme, 40, true);
  assert.ok(lines.some((l) => l.includes('⚙ bash')));
  assert.ok(lines.some((l) => l.includes('file listing output')));
});

test('aggregateUsage sums assistant message usage', () => {
  const entries: SessionEntry[] = [
    entry('message', { message: assistantMessage('a', undefined, 0.5) }),
    entry('message', { message: { role: 'user', content: 'q', timestamp: 1 } }),
    entry('message', { message: assistantMessage('b', undefined, 0.25) }),
  ];
  const totals = aggregateUsage(entries);
  assert.strictEqual(totals.input, 20);
  assert.strictEqual(totals.output, 40);
  assert.strictEqual(totals.totalTokens, 60);
  assert.strictEqual(totals.totalCost, 0.75);
});

test('getRenderedTranscript caches by path, width, and meta flag', () => {
  clearTranscriptCache();
  withTempDir('sv-transcript-', (dir) => {
    const path = join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'abc12345',
        timestamp: '2026-09-30T14:05:00.000Z',
        cwd: '/tmp/proj',
      }),
      JSON.stringify(entry('message', { message: { role: 'user', content: 'cache me', timestamp: 1 } })),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const first = getRenderedTranscript(path, 40, true, identityTheme);
    const second = getRenderedTranscript(path, 40, true, identityTheme);
    assert.strictEqual(first, second);
    assert.ok(first.some((l) => l.includes('cache me')));

    const differentFlag = getRenderedTranscript(path, 40, false, identityTheme);
    assert.notStrictEqual(first, differentFlag);
    const differentWidth = getRenderedTranscript(path, 60, true, identityTheme);
    assert.notStrictEqual(first, differentWidth);
  });
});

test('getRenderedTranscript returns an error line for unreadable sessions', () => {
  clearTranscriptCache();
  const lines = getRenderedTranscript('/nonexistent/session.jsonl', 40, true, identityTheme);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0]!.includes('Could not read session'));
});
