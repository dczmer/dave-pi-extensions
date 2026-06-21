import { strictEqual, ok, rejects } from 'node:assert';
import { test, mock, type Mock } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolvePlanModeOnSessionStart,
  evaluateToolCall,
  augmentSystemPrompt,
  isBlockedInput,
  extractPlanPathFromInput,
} from '../../../extensions/plan-mode/index.ts';
import planModeExtension from '../../../extensions/plan-mode/index.ts';
import { PARSE_FAILURE_REASON } from '../../../extensions/plan-mode/bash-guard.ts';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createPiTestHarness, captureEvents } from '../../utils/pi-harness.ts';
import { createUIContext, createSessionManagerStub, createExtensionContext } from '../../utils/pi-context.ts';
import { withTempDir } from '../../utils/temp-dir.ts';
import { createMockExtensionAPI, type MockedExtensionAPI } from '../../utils/mock-pi-api.ts';

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

test('augmentSystemPrompt: disabled returns disabled marker', () => {
  const result = augmentSystemPrompt(false, 'Hello');
  ok(result.systemPrompt.includes('Hello'));
  ok(result.systemPrompt.includes('[PLAN MODE: DISABLED]'));
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

test('augmentSystemPrompt: injects re-entry prefix when plan file exists', () => {
  withTempDir('pi-plan-', (dir) => {
    const planPath = join(dir, 'plan-20260513-abc123.md');
    writeFileSync(planPath, '# Existing plan');
    const result = augmentSystemPrompt(true, 'System', planPath);
    ok(result!.systemPrompt.includes('[PLAN RE-ENTRY]'));
    ok(result!.systemPrompt.includes('plan-20260513-abc123.md'));
    ok(result!.systemPrompt.includes('same task'));
  });
});

test('augmentSystemPrompt: omits re-entry prefix when plan file does not exist', () => {
  withTempDir('pi-plan-', (dir) => {
    const planPath = join(dir, 'plan-20260513-abc123.md');
    const result = augmentSystemPrompt(true, 'System', planPath);
    strictEqual(result!.systemPrompt.includes('[PLAN RE-ENTRY]'), false);
    ok(result!.systemPrompt.includes('PLANNING MODE ACTIVE'));
  });
});

test('augmentSystemPrompt: returns generic prompt when planFilePath not provided', () => {
  const result = augmentSystemPrompt(true, 'System');
  ok(result!.systemPrompt.includes('System'));
  ok(result!.systemPrompt.includes('PLANNING MODE ACTIVE'));
  ok(result!.systemPrompt.includes('/tmp/'));
  strictEqual(result!.systemPrompt.includes('plan file at'), false);
});

test('evaluateToolCall: allows write to current plan path in plan mode', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-abc123.md',
    '/project',
    '/project/.pi/artifacts/plan-20260512-abc123.md',
  );
  strictEqual(result, undefined);
});

test('evaluateToolCall: allows write to exact current plan path', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '/project/.pi/artifacts/plan-20260512-abc123.md',
    '/project',
    '/project/.pi/artifacts/plan-20260512-abc123.md',
  );
  strictEqual(result, undefined);
});

test('evaluateToolCall: blocks write to non-current plan path', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-oldslug.md',
    '/project',
    '/project/.pi/artifacts/plan-20260512-abc123.md',
  );
  strictEqual(result?.block, true);
  ok(result!.reason.includes('Planning mode active'));
});

test('evaluateToolCall: blocks write to plan artifact when no path set', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-abc123.md',
    '/project',
    undefined,
  );
  strictEqual(result?.block, true);
  ok(result!.reason.includes('Planning mode active'));
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

test('tool_call handler: parse failure with user confirm allows', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const { results, ctx } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: "echo 'unclosed" } },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => true),
        }),
      },
    );
    strictEqual(results[0], undefined);
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    strictEqual(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0],
      'Command not parsable — manual approval required',
    );
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[1], 'warning');
  });
});

test('tool_call handler: parse failure with user reject blocks', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: "echo 'unclosed" } },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => false),
        }),
      },
    );
    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    strictEqual(result?.reason, PARSE_FAILURE_REASON);
  });
});

test('tool_call handler: destructive command blocks without prompt', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const { results, ctx } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'rm file.txt' } },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => false),
        }),
      },
    );
    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    ok(result!.reason.includes('rm'));
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 0);
  });
});

test('tool_call handler: emits harness:block for edit block', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'edit',
      input: { path: 'src/index.ts' },
      toolCallId: 'call-edit-1',
    });

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);

    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-edit-1');
    strictEqual(data.tool, 'edit');
    strictEqual(data.extension, 'plan-mode');
    ok(data.reason.includes('Planning mode active'));
  });
});

test('tool_call handler: emits harness:block for write block', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'write',
      input: { path: 'src/index.ts' },
      toolCallId: 'call-write-1',
    });

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);

    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-write-1');
    strictEqual(data.tool, 'write');
    strictEqual(data.extension, 'plan-mode');
  });
});

test('tool_call handler: emits harness:block for bash block', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'bash',
      input: { command: 'npm install' },
      toolCallId: 'call-bash-1',
    });

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);

    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-bash-1');
    strictEqual(data.tool, 'bash');
    strictEqual(data.extension, 'plan-mode');
    ok(data.reason.includes('npm'));
  });
});

test('tool_call handler: parse failure rejection emits harness:block', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: "echo 'unclosed" }, toolCallId: 'call-parse-1' },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => false),
        }),
      },
    );

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);

    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-parse-1');
    strictEqual(data.tool, 'bash');
    strictEqual(data.extension, 'plan-mode');
    strictEqual(data.reason, PARSE_FAILURE_REASON);
  });
});

test('tool_call handler: allowed tool does not emit harness:block', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'read',
      input: { path: 'src/index.ts' },
      toolCallId: 'call-read-1',
    });

    strictEqual(results[0], undefined);
    strictEqual(emitted.length, 0);
  });
});

test('isBlockedInput: matches implement prefix', () => {
  strictEqual(isBlockedInput('implement the plan'), true);
  strictEqual(isBlockedInput('Implement the plan'), true);
  strictEqual(isBlockedInput('IMPLEMENT'), true);
});

test('isBlockedInput: matches commit prefix', () => {
  strictEqual(isBlockedInput('commit the changes'), true);
  strictEqual(isBlockedInput('Commit changes'), true);
  strictEqual(isBlockedInput('COMMIT'), true);
});

test('isBlockedInput: ignores non-matching text', () => {
  strictEqual(isBlockedInput('plan the implementation'), false);
  strictEqual(isBlockedInput('how do I commit?'), false);
  strictEqual(isBlockedInput(''), false);
  strictEqual(isBlockedInput('hello'), false);
});

test('input handler: blocks implement message in plan mode', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;

    const { results, ctx } = await harness.emitEvent('input', { text: 'implement the plan' });

    strictEqual((results[0] as { action: string }).action, 'handled');
    strictEqual(sendMessageSpy.mock.callCount(), 1);
    const msg = sendMessageSpy.mock.calls[0]!.arguments[0] as {
      customType: string;
      content: string;
      display: boolean;
    };
    strictEqual(msg.customType, 'plan-mode-block');
    ok(msg.content.includes('Plan mode is active'));
    strictEqual(msg.display, false);
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[1], 'warning');
  });
});

test('input handler: blocks commit message in plan mode', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;

    const { results, ctx } = await harness.emitEvent('input', { text: 'COMMIT changes' });

    strictEqual((results[0] as { action: string }).action, 'handled');
    strictEqual(sendMessageSpy.mock.callCount(), 1);
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
  });
});

test('input handler: allows non-blocked text in plan mode', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const { results, ctx } = await harness.emitEvent('input', { text: 'what is the plan?' });

    strictEqual((results[0] as { action: string }).action, 'continue');
    strictEqual(sendMessageSpy.mock.callCount(), 0);
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 0);
  });
});

test('input handler: allows blocked text when plan mode is disabled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    // Toggle plan mode off via /plan command
    await harness.command('plan').execute('');

    const { results } = await harness.emitEvent('input', { text: 'implement the plan' });

    strictEqual((results[0] as { action: string }).action, 'continue');
    // sendMessages has the toggle-off message only
    strictEqual(sendMessageSpy.mock.callCount(), 1);
  });
});

test('toggle sends hidden message when enabling plan mode', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    // Toggle off (starts on)
    await harness.command('plan').execute('');
    // Toggle back on
    await harness.command('plan').execute('');

    const toggleMessages = sendMessageSpy.mock.calls
      .map((c) => c.arguments[0] as { customType: string; content: string; display: boolean })
      .filter((m) => m.customType === 'plan-mode-toggle');
    strictEqual(toggleMessages.length, 2);
    const onMsg = toggleMessages[1]!;
    strictEqual(onMsg.display, false);
    ok(onMsg.content.includes('enabled'));
  });
});

test('toggle sends hidden message when disabling plan mode', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
    harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    // Toggle off (starts on)
    await harness.command('plan').execute('');

    const toggleMessages = sendMessageSpy.mock.calls
      .map((c) => c.arguments[0] as { customType: string; content: string; display: boolean })
      .filter((m) => m.customType === 'plan-mode-toggle');
    strictEqual(toggleMessages.length, 1);
    const offMsg = toggleMessages[0]!;
    strictEqual(offMsg.display, false);
    ok(offMsg.content.includes('disabled'));
  });
});

test('input handler: generates plan slug from first user input when plan mode active', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const before1 = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const genericPrompt = (before1.results[0] as { systemPrompt: string }).systemPrompt;
    ok(genericPrompt.includes('PLANNING MODE ACTIVE'));
    ok(genericPrompt.includes('/tmp/'));
    strictEqual(genericPrompt.includes('plan file at'), false);

    const inputResult = await harness.emitEvent('input', { text: 'Add a caching layer for the API' });
    strictEqual((inputResult.results[0] as { action: string }).action, 'continue');

    const before2 = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before2.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLANNING MODE ACTIVE'));
    ok(prompt.includes('plan-'));
    ok(prompt.includes('add-a-caching-layer-for-the'));
  });
});

test('input handler: does not generate slug when plan mode is disabled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    await harness.command('plan').execute('');

    const inputResult = await harness.emitEvent('input', { text: 'Add a caching layer to the API' });
    strictEqual((inputResult.results[0] as { action: string }).action, 'continue');

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('System'));
    ok(prompt.includes('[PLAN MODE: DISABLED]'));
  });
});

test('session_start: does not generate slug when plan mode enabled and no persisted state', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    await harness.emitEvent('session_start', { reason: 'new' });

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLANNING MODE ACTIVE'));
    ok(prompt.includes('/tmp/'));
    strictEqual(prompt.includes('plan file at'), false);
  });
});

test('session_start: restores persisted slug on resume', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    await harness.emitEvent(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: createSessionManagerStub({
          getEntries: mock.fn(() => [
            {
              id: 'entry-1',
              parentId: null,
              timestamp: new Date().toISOString(),
              type: 'custom',
              customType: 'plan-mode-state',
              data: { enabled: true, slug: 'plan-20260512-abc123' },
            },
          ]),
        }),
      },
    );

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('plan-20260512-abc123.md'));
  });
});

test('default export registers all handlers even when --no-plan flag is set', () => {
  const pi = createMockExtensionAPI({
    getFlag: (name: string) => (name === 'no-plan' ? true : undefined),
  });

  planModeExtension(pi as unknown as ExtensionAPI);

  strictEqual(pi.registerFlag.mock.callCount(), 2);
  strictEqual(pi.registerCommand.mock.callCount(), 1);
  strictEqual(pi.registerShortcut.mock.callCount(), 1);
  strictEqual(pi.on.mock.callCount(), 4);
});

test('session_start with --no-plan initializes disabled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'no-plan' ? true : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    ok(result.systemPrompt.includes('[PLAN MODE: DISABLED]'));
  });
});

test('session_start without --no-plan initializes enabled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({ getFlag: () => false });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    ok(result.systemPrompt.includes('PLANNING MODE ACTIVE'));
  });
});

// ── Natural-language path detection ───────────────────────────

test('extractPlanPathFromInput matches load plan from', () => {
  strictEqual(extractPlanPathFromInput('load plan from plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput matches load and refine', () => {
  strictEqual(extractPlanPathFromInput('load and refine plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput matches use plan at', () => {
  strictEqual(extractPlanPathFromInput('use plan at plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput matches refine plan', () => {
  strictEqual(extractPlanPathFromInput('refine plan plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput matches switch plan to', () => {
  strictEqual(extractPlanPathFromInput('switch plan to plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput matches continue plan', () => {
  strictEqual(extractPlanPathFromInput('continue plan plans/foo.md'), 'plans/foo.md');
});

test('extractPlanPathFromInput returns undefined for unrelated text', () => {
  strictEqual(extractPlanPathFromInput('what is the plan?'), undefined);
});

test('extractPlanPathFromInput strips quotes from quoted path', () => {
  strictEqual(extractPlanPathFromInput('load plan from "plans/my plan.md"'), 'plans/my plan.md');
});

test('extractPlanPathFromInput does not strip conjunction inside quoted path', () => {
  strictEqual(extractPlanPathFromInput('load plan from "plans/foo and bar.md"'), 'plans/foo and bar.md');
});

test('extractPlanPathFromInput returns undefined for prose without path', () => {
  strictEqual(extractPlanPathFromInput('load and refine the plan'), undefined);
});

test('extractPlanPathFromInput preserves quoted path containing conjunction', () => {
  strictEqual(extractPlanPathFromInput('load plan from "plans/foo and bar.md"'), 'plans/foo and bar.md');
});

test('extractPlanPathFromInput ignores trailing prose after conjunction', () => {
  strictEqual(extractPlanPathFromInput('load plan from plans/foo.md and implement it'), 'plans/foo.md');
});

test('extractPlanPathFromInput accepts relative filename with extension', () => {
  strictEqual(extractPlanPathFromInput('use plan at plan.md'), 'plan.md');
});

// ── CLI flag --plan-file ──────────────────────────────────────

test('session_start: --plan-file existing file injects re-entry prefix', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const planPath = join(dir, 'plans', 'PLAN_TMUX-SUBAGENTS.md');
    writeFileSync(planPath, '# Existing plan');

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? 'plans/PLAN_TMUX-SUBAGENTS.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    ok(result.systemPrompt.includes('[PLAN RE-ENTRY]'));
    ok(result.systemPrompt.includes(planPath));
  });
});

test('session_start: --plan-file non-existing file injects normal planning prompt', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const planPath = join(dir, 'plans', 'PLAN_NEW.md');

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? 'plans/PLAN_NEW.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    strictEqual(result.systemPrompt.includes('[PLAN RE-ENTRY]'), false);
    ok(result.systemPrompt.includes('PLANNING MODE ACTIVE'));
    ok(result.systemPrompt.includes(planPath));
  });
});

test('session_start: --plan-file with missing parent directory warns', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? 'missing/foo.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'parent directory does not exist',
      ),
    );
  });
});

test('session_start: --plan-file with --no-plan raises error', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => {
        if (name === 'no-plan') return true;
        if (name === 'plan-file') return 'plans/foo.md';
        return undefined;
      },
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await rejects(sessionStartHandler!({ reason: 'startup' }, ctx), /Cannot use --plan-file with --no-plan/);
  });
});

test('session_start: reason new ignores --plan-file', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? 'plans/PLAN_TMUX-SUBAGENTS.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'new' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    ok(result.systemPrompt.includes('PLANNING MODE ACTIVE'));
    strictEqual(result.systemPrompt.includes('PLAN_TMUX-SUBAGENTS.md'), false);
  });
});

test('session_start: --plan-file outside cwd warns', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = createMockExtensionAPI({
      getFlag: (name: string) => (name === 'plan-file' ? '/other/foo.md' : undefined),
    });
    pi.on = ((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    }) as MockedExtensionAPI['on'];

    planModeExtension(pi as unknown as ExtensionAPI);

    const sessionStartHandler = handlers.get('session_start');
    ok(sessionStartHandler);
    const beforeAgentStartHandler = handlers.get('before_agent_start');
    ok(beforeAgentStartHandler);

    const ctx = createExtensionContext({ cwd: dir });
    await sessionStartHandler!({ reason: 'startup' }, ctx);
    const result = (await beforeAgentStartHandler!({ systemPrompt: 'System' }, ctx)) as {
      systemPrompt: string;
    };

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('must be inside project'));
    ok(result.systemPrompt.includes('PLANNING MODE ACTIVE'));
    strictEqual(result.systemPrompt.includes('/other/foo.md'), false);
  });
});

// ── /plan <path> command ──────────────────────────────────────

test('/plan <path> switches active plan file', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    await harness.command('plan').execute('plans/PLAN_TMUX-SUBAGENTS.md');

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLAN_TMUX-SUBAGENTS.md'));
  });
});

test('/plan <path> enables plan mode when disabled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    await harness.command('plan').execute('');
    const beforeDisabled = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    ok((beforeDisabled.results[0] as { systemPrompt: string }).systemPrompt.includes('[PLAN MODE: DISABLED]'));

    await harness.command('plan').execute('plans/PLAN_TMUX-SUBAGENTS.md');
    const beforeEnabled = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (beforeEnabled.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLANNING MODE ACTIVE'));
    ok(prompt.includes('PLAN_TMUX-SUBAGENTS.md'));
  });
});

test('/plan <path> rejects path outside cwd', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const ctx = await harness.command('plan').execute('/other/foo.md');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('must be inside project'));

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLANNING MODE ACTIVE'));
    strictEqual(prompt.includes('/other/foo.md'), false);
  });
});

test('/plan <path> rejects directory', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'));
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const ctx = await harness.command('plan').execute('plans');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('is a directory'));
  });
});

test('/plan <path> rejects missing parent directory', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const ctx = await harness.command('plan').execute('missing/foo.md');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'parent directory does not exist',
      ),
    );
  });
});

// ── Natural-language path detection ───────────────────────────

test('input handler: natural language sets plan path before blocked check', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans', 'PLAN_TMUX-SUBAGENTS.md'), '# Plan');
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const inputResult = await harness.emitEvent('input', { text: 'load and refine plans/PLAN_TMUX-SUBAGENTS.md' });
    strictEqual((inputResult.results[0] as { action: string }).action, 'continue');

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('[PLAN RE-ENTRY]'));
    ok(prompt.includes('PLAN_TMUX-SUBAGENTS.md'));
  });
});

test('input handler: natural language path outside cwd is rejected', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);

    const inputResult = await harness.emitEvent('input', { text: 'load plan from /other/foo.md' });
    strictEqual((inputResult.results[0] as { action: string }).action, 'handled');
    strictEqual((inputResult.ctx.ui.notify as Mock<typeof inputResult.ctx.ui.notify>).mock.callCount(), 1);
    ok(
      (inputResult.ctx.ui.notify as Mock<typeof inputResult.ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'must be inside project',
      ),
    );
  });
});

test('input handler: quoted natural language path with spaces is handled', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans', 'my plan.md'), '# Plan');
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const inputResult = await harness.emitEvent('input', { text: 'load plan from "plans/my plan.md"' });
    strictEqual((inputResult.results[0] as { action: string }).action, 'continue');

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('my plan.md'));
  });
});

// ── Persistence ───────────────────────────────────────────────

test('session_start: restores persisted planPath', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const planPath = join(dir, 'plans', 'PLAN_TMUX-SUBAGENTS.md');
    writeFileSync(planPath, '# Plan');
    const harness = await createPiTestHarness(planModeExtension, dir);

    await harness.emitEvent(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: createSessionManagerStub({
          getEntries: mock.fn(() => [
            {
              id: 'entry-1',
              parentId: null,
              timestamp: new Date().toISOString(),
              type: 'custom',
              customType: 'plan-mode-state',
              data: { enabled: true, planPath },
            },
          ]),
        }),
      },
    );

    const before = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('[PLAN RE-ENTRY]'));
    ok(prompt.includes(planPath));
  });
});

test('persist: custom path stores planPath and omits slug', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    const ctx = await harness.command('plan').execute('plans/PLAN_TMUX-SUBAGENTS.md');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('Plan file set to'));
    ok(
      (ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(
        'plans/PLAN_TMUX-SUBAGENTS.md',
      ),
    );

    strictEqual((harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.callCount(), 1);
    const entry = (harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.calls[0]!
      .arguments[1] as {
      enabled: boolean;
      planPath?: string;
      slug?: string;
    };
    strictEqual(entry.enabled, true);
    ok(entry.planPath?.includes('plans/PLAN_TMUX-SUBAGENTS.md'));
    strictEqual(entry.slug, undefined);
  });
});

test('persist: artifact path stores both planPath and slug', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;

    // Generate an artifact plan by providing user input
    await harness.emitEvent('input', { text: 'Add caching layer to the API' });

    strictEqual((harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.callCount(), 1);
    const entry = (harness.runtime.appendEntry as Mock<typeof harness.runtime.appendEntry>).mock.calls[0]!
      .arguments[1] as {
      enabled: boolean;
      planPath?: string;
      slug?: string;
    };
    strictEqual(entry.enabled, true);
    ok(entry.planPath?.includes('.pi/artifacts/plan-'));
    ok(entry.slug?.startsWith('plan-'));
    strictEqual(entry.planPath?.endsWith(`${entry.slug}.md`), true);
  });
});

test('session_start: reason new resets currentPlanPath', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const planPath = join(dir, 'plans', 'PLAN_TMUX-SUBAGENTS.md');
    writeFileSync(planPath, '# Plan');
    const harness = await createPiTestHarness(planModeExtension, dir);

    await harness.emitEvent(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: createSessionManagerStub({
          getEntries: mock.fn(() => [
            {
              id: 'entry-1',
              parentId: null,
              timestamp: new Date().toISOString(),
              type: 'custom',
              customType: 'plan-mode-state',
              data: { enabled: true, planPath },
            },
          ]),
        }),
      },
    );

    const before1 = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    ok((before1.results[0] as { systemPrompt: string }).systemPrompt.includes(planPath));

    await harness.emitEvent('session_start', { reason: 'new' });
    const before2 = await harness.emitEvent('before_agent_start', { systemPrompt: 'System' });
    const prompt = (before2.results[0] as { systemPrompt: string }).systemPrompt;
    ok(prompt.includes('PLANNING MODE ACTIVE'));
    strictEqual(prompt.includes(planPath), false);
  });
});

// ── Tool guard with custom plan path ──────────────────────────

test('evaluateToolCall: allows write to custom current plan path', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    'plans/PLAN_TMUX-SUBAGENTS.md',
    '/project',
    '/project/plans/PLAN_TMUX-SUBAGENTS.md',
  );
  strictEqual(result, undefined);
});

test('evaluateToolCall: blocks write to non-selected plan path', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    'plans/PLAN_OTHER.md',
    '/project',
    '/project/plans/PLAN_TMUX-SUBAGENTS.md',
  );
  strictEqual(result?.block, true);
  ok(result!.reason.includes('Planning mode active'));
});

test('tool_call handler: write to custom plan path is allowed', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;
    const emitted = captureEvents(harness, 'harness:block');

    await harness.command('plan').execute('plans/PLAN_TMUX-SUBAGENTS.md');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'write',
      input: { path: 'plans/PLAN_TMUX-SUBAGENTS.md' },
      toolCallId: 'call-write-plan-1',
    });

    strictEqual(results[0], undefined);
    strictEqual(emitted.length, 0);
  });
});

test('tool_call handler: write to non-selected plan path is blocked', async () => {
  await withTempDir('pi-plan-', async (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const harness = await createPiTestHarness(planModeExtension, dir);
    harness.runtime.sendMessage = mock.fn(() => {}) as unknown as typeof harness.runtime.sendMessage;
    harness.runtime.appendEntry = mock.fn(() => {}) as unknown as typeof harness.runtime.appendEntry;
    const emitted = captureEvents(harness, 'harness:block');

    await harness.command('plan').execute('plans/PLAN_TMUX-SUBAGENTS.md');

    const { results } = await harness.emitEvent('tool_call', {
      toolName: 'write',
      input: { path: 'plans/PLAN_OTHER.md' },
      toolCallId: 'call-write-other-1',
    });

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-write-other-1');
    strictEqual(data.tool, 'write');
    strictEqual(data.extension, 'plan-mode');
  });
});
