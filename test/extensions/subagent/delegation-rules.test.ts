import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import type { BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent';
import { DELEGATION_RULES, appendDelegationRules } from '../../../extensions/subagent/delegation-rules.ts';
import { createSubagentExtension } from '../../../extensions/subagent/index.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';

test('appendDelegationRules appends the block once, separated by a blank line', () => {
  const base = 'BASE PROMPT';
  const result = appendDelegationRules(base);
  strictEqual(result, `${base}\n\n${DELEGATION_RULES}`);
  strictEqual(result.split('## Subagent Delegation').length - 1, 1, 'block must appear exactly once');
});

test('appendDelegationRules leaves the input prompt untouched otherwise', () => {
  const base = 'line one\nline two';
  const result = appendDelegationRules(base);
  ok(result.startsWith(`${base}\n\n`));
  ok(result.endsWith(DELEGATION_RULES));
});

test('the block contains the four load-bearing rules', () => {
  // Assert on distinctive phrases so a silent text regression fails loudly.
  ok(DELEGATION_RULES.includes('self-contained dispatch'), 'self-contained dispatch rule');
  ok(DELEGATION_RULES.includes('`tasks` array mode'), 'parallel tasks mode rule');
  ok(DELEGATION_RULES.includes('edit overlapping files'), 'no parallel overlapping edits rule');
  ok(DELEGATION_RULES.includes('report a brief summary to the user'), 'brief summary reporting rule');
});

test('handler integration: before_agent_start returns BASE + blank line + rules', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}));
  const { results } = await harness.emitEvent('before_agent_start', { systemPrompt: 'BASE' });
  strictEqual(results.length, 1);
  const result = results[0] as BeforeAgentStartEventResult;
  strictEqual(result.systemPrompt, `BASE\n\n${DELEGATION_RULES}`);
});

test('child exclusion: PI_SUBAGENT_CHILD registers no before_agent_start handler', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({ PI_SUBAGENT_CHILD: '1' }));
  strictEqual(harness.listRegisteredTools().length, 0);
  const { results } = await harness.emitEvent('before_agent_start', { systemPrompt: 'BASE' });
  strictEqual(results.length, 0, 'child sessions must not receive delegation rules');
});
