import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  createProgressState,
  statusLineFromEvent,
  truncateStatus,
  STATUS_MAX_WIDTH,
} from '../../../extensions/subagent/progress.ts';

function textDelta(delta: string, contentIndex = 0) {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex, delta } };
}

test('text_delta accumulates and reports the last non-empty line', () => {
  const state = createProgressState();
  strictEqual(statusLineFromEvent(textDelta('Hello wor'), state), 'Hello wor');
  strictEqual(statusLineFromEvent(textDelta('ld\nNow on line two'), state), 'Now on line two');
  strictEqual(state.lastLine, 'Now on line two');
});

test('text blocks are buffered per contentIndex', () => {
  const state = createProgressState();
  statusLineFromEvent(textDelta('first block', 0), state);
  strictEqual(statusLineFromEvent(textDelta('second block', 1), state), 'second block');
  strictEqual(statusLineFromEvent(textDelta(' continues', 0), state), 'first block continues');
});

test('thinking_delta events are ignored', () => {
  const state = createProgressState();
  const event = {
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
  };
  strictEqual(statusLineFromEvent(event, state), undefined);
  strictEqual(state.lastLine, '');
});

test('text_end replaces the buffered block with authoritative content', () => {
  const state = createProgressState();
  statusLineFromEvent(textDelta('partial junk'), state);
  const event = {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'final\ntext' },
  };
  strictEqual(statusLineFromEvent(event, state), 'text');
});

test('tool_execution_start synthesizes a tool call line', () => {
  const state = createProgressState();
  const event = { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls -la' } };
  strictEqual(statusLineFromEvent(event, state), '→ bash {"command":"ls -la"}');
});

test('tool_execution_update reports the last line of partial result text', () => {
  const state = createProgressState();
  const event = {
    type: 'tool_execution_update',
    toolCallId: 'c1',
    toolName: 'bash',
    args: {},
    partialResult: { content: [{ type: 'text', text: 'line one\nline two\n' }] },
  };
  strictEqual(statusLineFromEvent(event, state), 'line two');
});

test('unrelated events produce no status line', () => {
  const state = createProgressState();
  strictEqual(statusLineFromEvent({ type: 'agent_start' }, state), undefined);
  strictEqual(statusLineFromEvent(null, state), undefined);
  strictEqual(statusLineFromEvent('nope', state), undefined);
});

test('truncateStatus caps output at 80 display columns', () => {
  const truncated = truncateStatus('x'.repeat(120));
  strictEqual(visibleWidth(truncated), STATUS_MAX_WIDTH);
  ok(stripTerminalSequences(truncated).endsWith('...'));
});

test('truncateStatus handles wide characters without exceeding 80 columns', () => {
  const truncated = truncateStatus('あ'.repeat(60));
  ok(visibleWidth(truncated) <= STATUS_MAX_WIDTH, `width was ${visibleWidth(truncated)}`);
});

test('truncateStatus leaves short lines untouched', () => {
  strictEqual(truncateStatus('short'), 'short');
});
