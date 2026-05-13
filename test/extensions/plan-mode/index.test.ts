import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import {
  resolvePlanModeOnSessionStart,
  evaluateToolCall,
  augmentSystemPrompt,
} from '../../../extensions/plan-mode/index.ts';

test('resolvePlanModeOnSessionStart: startup with default flag and no persisted state', () => {
  strictEqual(resolvePlanModeOnSessionStart('startup', false, undefined), true);
});

test('resolvePlanModeOnSessionStart: startup respects --no-plan flag', () => {
  strictEqual(resolvePlanModeOnSessionStart('startup', true, undefined), false);
});

test('resolvePlanModeOnSessionStart: startup with persisted disabled overrides default', () => {
  strictEqual(resolvePlanModeOnSessionStart('startup', false, false), false);
});

test('resolvePlanModeOnSessionStart: startup with persisted enabled overrides --no-plan', () => {
  strictEqual(resolvePlanModeOnSessionStart('startup', true, true), true);
});

test('resolvePlanModeOnSessionStart: new session enables plan mode by default', () => {
  strictEqual(resolvePlanModeOnSessionStart('new', false, undefined), true);
});

test('resolvePlanModeOnSessionStart: new session respects --no-plan flag', () => {
  strictEqual(resolvePlanModeOnSessionStart('new', true, undefined), false);
});

test('resolvePlanModeOnSessionStart: new session ignores persisted disabled state', () => {
  strictEqual(resolvePlanModeOnSessionStart('new', false, false), true);
});

test('resolvePlanModeOnSessionStart: resume restores persisted disabled state', () => {
  strictEqual(resolvePlanModeOnSessionStart('resume', false, false), false);
});

test('evaluateToolCall: disabled mode allows everything', () => {
  strictEqual(evaluateToolCall(false, 'edit', undefined), undefined);
  strictEqual(evaluateToolCall(false, 'write', undefined), undefined);
  strictEqual(evaluateToolCall(false, 'bash', 'rm file.txt'), undefined);
});

test('evaluateToolCall: blocks edit in plan mode', () => {
  const result = evaluateToolCall(true, 'edit', undefined);
  strictEqual(result?.block, true);
  ok(result?.reason.includes('Planning mode active'));
});

test('evaluateToolCall: blocks write in plan mode', () => {
  const result = evaluateToolCall(true, 'write', undefined);
  strictEqual(result?.block, true);
  ok(result?.reason.includes('Planning mode active'));
});

test('evaluateToolCall: blocks destructive bash in plan mode', () => {
  const result = evaluateToolCall(true, 'bash', 'rm file.txt');
  strictEqual(result?.block, true);
  ok(result!.reason.length > 0);
});

test('evaluateToolCall: allows safe bash in plan mode', () => {
  strictEqual(evaluateToolCall(true, 'bash', 'ls -la'), undefined);
});

test('evaluateToolCall: allows bash with empty command in plan mode', () => {
  strictEqual(evaluateToolCall(true, 'bash', ''), undefined);
});

test('evaluateToolCall: allows other tools in plan mode', () => {
  strictEqual(evaluateToolCall(true, 'read', undefined), undefined);
  strictEqual(evaluateToolCall(true, 'grep', undefined), undefined);
});

test('augmentSystemPrompt: disabled returns undefined', () => {
  strictEqual(augmentSystemPrompt(false, 'Hello'), undefined);
});

test('augmentSystemPrompt: enabled appends planning prompt', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('System'));
  ok(result!.systemPrompt.includes('PLANNING MODE ACTIVE'));
});

test('augmentSystemPrompt: includes exact plan file path', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('/project/.pi/artifacts/plan-20260512-abc123.md'));
});

test('augmentSystemPrompt: includes software architect framing', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('software architect'));
});

test('augmentSystemPrompt: lists safe commands', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('ls'));
  ok(result!.systemPrompt.includes('git status'));
  ok(result!.systemPrompt.includes('git log'));
});

test('augmentSystemPrompt: lists blocked commands', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('rm'));
  ok(result!.systemPrompt.includes('npm'));
  ok(result!.systemPrompt.includes('docker'));
});

test('augmentSystemPrompt: mentions /tmp allowance', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('/tmp/'));
});

test('augmentSystemPrompt: mentions mkdir exception', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('mkdir'));
  ok(result!.systemPrompt.includes('.pi/artifacts'));
});

test('augmentSystemPrompt: includes mermaid/ascii mention', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('mermaid'));
});

test('augmentSystemPrompt: includes supersede clause', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('supersede'));
});

test('augmentSystemPrompt: includes re-entry instruction', () => {
  const result = augmentSystemPrompt(true, 'System', '/project/.pi/artifacts/plan-20260512-abc123.md');
  ok(result!.systemPrompt.includes('already exists'));
  ok(result!.systemPrompt.includes('read it first'));
});

test('augmentSystemPrompt: omits plan path when not provided', () => {
  const result = augmentSystemPrompt(true, 'System');
  ok(result!.systemPrompt.includes('.pi/artifacts/plan-<slug>.md'));
});

test('evaluateToolCall: allows write to plan artifact in plan mode', () => {
  const result = evaluateToolCall(true, 'write', undefined, '.pi/artifacts/plan-20260512-abc123.md', '/project');
  strictEqual(result, undefined);
});

test('evaluateToolCall: allows write to /tmp in plan mode', () => {
  const result = evaluateToolCall(true, 'write', undefined, '/tmp/scratch.txt', '/project');
  strictEqual(result, undefined);
});

test('evaluateToolCall: blocks write to bare plan.md in plan mode', () => {
  const result = evaluateToolCall(true, 'write', undefined, '.pi/artifacts/plan.md', '/project');
  strictEqual(result?.block, true);
});

test('evaluateToolCall: blocks write to src/index.ts in plan mode', () => {
  const result = evaluateToolCall(true, 'write', undefined, 'src/index.ts', '/project');
  strictEqual(result?.block, true);
});

test('evaluateToolCall: allows write to any path when plan mode is off', () => {
  strictEqual(evaluateToolCall(false, 'write', undefined, 'src/index.ts', '/project'), undefined);
  strictEqual(evaluateToolCall(false, 'write', undefined, '.pi/artifacts/plan.md', '/project'), undefined);
});

test('evaluateToolCall: allows mkdir under artifact dir in plan mode', () => {
  strictEqual(evaluateToolCall(true, 'bash', 'mkdir -p .pi/artifacts', undefined, '/project'), undefined);
});

test('evaluateToolCall: blocks mkdir outside artifact dir in plan mode', () => {
  const result = evaluateToolCall(true, 'bash', 'mkdir other', undefined, '/project');
  strictEqual(result?.block, true);
  ok(result!.reason.includes('mkdir'));
});

test('evaluateToolCall: allows mkdir outside artifact dir when plan mode is off', () => {
  strictEqual(evaluateToolCall(false, 'bash', 'mkdir other', undefined, '/project'), undefined);
});
