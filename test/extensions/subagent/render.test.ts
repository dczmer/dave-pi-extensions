import { ok } from 'node:assert';
import { test } from 'node:test';
import type { AgentToolResult, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createUIContext } from '../../utils/pi-context.ts';
import { renderSubagentResult } from '../../../extensions/subagent/render.ts';
import { zeroUsage, type SubagentRun } from '../../../extensions/subagent/runner.ts';
import type { SubagentDetails } from '../../../extensions/subagent/render.ts';

// Identity theme: fg/bg/bold all return their input unchanged.
const theme = createUIContext().theme;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id: Math.random().toString(36), name, arguments: args };
}

/** Build a complete 0.85.1 AssistantMessage from content parts. */
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

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agent: 'worker',
    task: 'fix the bug',
    statusLine: '',
    messages: [],
    usage: zeroUsage(),
    exitCode: 0,
    ...overrides,
  };
}

function render(details: SubagentDetails, expanded: boolean): string {
  const result: AgentToolResult<SubagentDetails> = {
    content: [{ type: 'text', text: 'done' }],
    details,
  };
  const options: ToolRenderResultOptions = { expanded, isPartial: false };
  return renderSubagentResult(result, options, theme).render(200).join('\n');
}

function makeItemRun(itemCount: number, overrides: Partial<SubagentRun> = {}): SubagentRun {
  const content: AssistantMessage['content'] = [];
  for (let i = 0; i < itemCount; i++) {
    content.push({ type: 'text', text: `step ${i}` });
    content.push(toolCall('bash', { command: `cmd-${i}` }));
  }
  content.push({ type: 'text', text: 'final report' });
  return makeRun({ messages: [assistantMsg(content)], ...overrides });
}

test('collapsed single run shows trailing items and final text', () => {
  const run = makeItemRun(3);
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('worker'));
  ok(text.includes('final report'));
  ok(text.includes('$ cmd-2'));
  // 7 items > COLLAPSED_ITEM_COUNT triggers elision plus the expand hint.
  ok(text.includes('earlier items'));
  ok(text.includes('(Ctrl+O to expand)'));
});

test('collapsed single run shows all items when within the limit', () => {
  const run = makeItemRun(1); // 3 items total: step 0, cmd-0, final report
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('$ cmd-0'));
  ok(!text.includes('earlier items'));
  ok(!text.includes('(Ctrl+O to expand)'));
});

test('collapsed live run shows items plus status line', () => {
  const run = makeItemRun(2, { exitCode: null, statusLine: 'thinking...' });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('$ cmd-1'));
  ok(text.includes('thinking...'));
});

test('collapsed failed run shows items plus error line', () => {
  const run = makeItemRun(1, { exitCode: 1, errorMessage: 'boom' });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('$ cmd-0'));
  ok(text.includes('boom'));
});

test('collapsed run without items shows (no output)', () => {
  const run = makeRun({ messages: [] });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('(no output)'));
});

test('collapsed parallel runs use the parallel item count', () => {
  const runs = [makeItemRun(2), makeItemRun(2)];
  const text = render({ mode: 'parallel', agentScope: 'both', results: runs }, false);
  ok(text.includes('parallel '));
  ok(text.includes('2/2 done'));
  // 5 items per run, done runs keep the last PARALLEL_COLLAPSED_ITEM_COUNT.
  ok(text.includes('earlier items'));
  ok(!text.includes('$ cmd-0')); // elided away
});

test('expanded run renders full trajectory and output section', () => {
  const run = makeItemRun(4);
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, true);
  ok(text.includes('─── Trajectory ───'));
  ok(text.includes('─── Output ───'));
  ok(text.includes('$ cmd-0')); // earliest item present, not elided
  ok(text.includes('$ cmd-3'));
  ok(text.includes('final report'));
});

test('expanded run shows task and error lines', () => {
  const run = makeItemRun(1, { exitCode: 1, errorMessage: 'kaboom', task: 'investigate' });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, true);
  ok(text.includes('Task: investigate'));
  ok(text.includes('Error: kaboom'));
});

test('expanded parallel renders aggregate usage total', () => {
  const usage = zeroUsage();
  usage.turns = 2;
  usage.input = 1200;
  const runs = [makeItemRun(1, { usage }), makeItemRun(1, { usage })];
  const text = render({ mode: 'parallel', agentScope: 'both', results: runs }, true);
  ok(text.includes('2/2 done'));
  ok(text.includes('Total: 4 turns'));
});

test('collapsed finished run shows the persisted session file path', () => {
  const run = makeRun({ sessionFile: '/home/u/.pi/agent/subagent-runs/x/s.jsonl' });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, false);
  ok(text.includes('session: /home/u/.pi/agent/subagent-runs/x/s.jsonl'));
});

test('expanded run shows the persisted session file path', () => {
  const run = makeRun({ sessionFile: '/home/u/.pi/agent/subagent-runs/x/s.jsonl' });
  const text = render({ mode: 'single', agentScope: 'both', results: [run] }, true);
  ok(text.includes('Session: /home/u/.pi/agent/subagent-runs/x/s.jsonl'));
});
