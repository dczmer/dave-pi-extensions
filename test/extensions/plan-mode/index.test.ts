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
  const result = augmentSystemPrompt(true, 'System');
  ok(result!.systemPrompt.includes('System'));
  ok(result!.systemPrompt.includes('PLANNING MODE ACTIVE'));
});
