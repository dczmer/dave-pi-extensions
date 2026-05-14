import { strictEqual, ok } from 'node:assert';
import { test, mock, type Mock } from 'node:test';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolvePlanModeOnSessionStart,
  evaluateToolCall,
  augmentSystemPrompt,
  maybeRenamePlanArtifact,
  isBlockedInput,
} from '../../../extensions/plan-mode/index.ts';
import planModeExtension from '../../../extensions/plan-mode/index.ts';
import { PARSE_FAILURE_REASON } from '../../../extensions/plan-mode/bash-guard.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';
import { createUIContext, createExtensionContext } from '../../utils/pi-context.ts';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-plan-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

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

test('augmentSystemPrompt: injects re-entry prefix when plan file exists', () => {
  withTempDir((dir) => {
    const planPath = join(dir, 'plan-20260513-abc123.md');
    writeFileSync(planPath, '# Existing plan');
    const result = augmentSystemPrompt(true, 'System', planPath);
    ok(result!.systemPrompt.includes('[PLAN RE-ENTRY]'));
    ok(result!.systemPrompt.includes('plan-20260513-abc123.md'));
    ok(result!.systemPrompt.includes('same task'));
  });
});

test('augmentSystemPrompt: omits re-entry prefix when plan file does not exist', () => {
  withTempDir((dir) => {
    const planPath = join(dir, 'plan-20260513-abc123.md');
    const result = augmentSystemPrompt(true, 'System', planPath);
    strictEqual(result!.systemPrompt.includes('[PLAN RE-ENTRY]'), false);
    ok(result!.systemPrompt.includes('PLANNING MODE ACTIVE'));
  });
});

test('augmentSystemPrompt: omits plan path when not provided', () => {
  const result = augmentSystemPrompt(true, 'System');
  ok(result!.systemPrompt.includes('.pi/artifacts/plan-<slug>.md'));
  strictEqual(result!.systemPrompt.includes('[PLAN RE-ENTRY]'), false);
});

test('evaluateToolCall: allows write to plan artifact in plan mode', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-abc123.md',
    '/project',
    'plan-20260512-abc123',
  );
  strictEqual(result, undefined);
});

test('evaluateToolCall: allows write to exact current plan artifact', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-abc123.md',
    '/project',
    'plan-20260512-abc123',
  );
  strictEqual(result, undefined);
});

test('evaluateToolCall: blocks write to non-current plan artifact with rename hint', () => {
  const result = evaluateToolCall(
    true,
    'write',
    undefined,
    '.pi/artifacts/plan-20260512-oldslug.md',
    '/project',
    'plan-20260512-abc123',
  );
  strictEqual(result?.block, true);
  ok(result!.reason.includes('renamed to plan-20260512-abc123.md'));
  ok(result!.reason.includes('current path'));
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

test('maybeRenamePlanArtifact: ignores non-write tool results', () => {
  withTempDir((dir) => {
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      'plan-20260512-abcd1234',
      { toolName: 'read', input: { path: '.pi/artifacts/plan-20260512-abcd1234.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('maybeRenamePlanArtifact: ignores write to non-plan file', () => {
  withTempDir((dir) => {
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      'plan-20260512-abcd1234',
      { toolName: 'write', input: { path: 'other.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('maybeRenamePlanArtifact: ignores when plan mode disabled', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.pi', 'artifacts'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'artifacts', 'plan-20260512-abcd1234.md'), '# Topic here');
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      false,
      'plan-20260512-abcd1234',
      { toolName: 'write', input: { path: '.pi/artifacts/plan-20260512-abcd1234.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('maybeRenamePlanArtifact: renames plan file based on topic', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.pi', 'artifacts'), { recursive: true });
    writeFileSync(
      join(dir, '.pi', 'artifacts', 'plan-20260512-abcd1234.md'),
      'Refactor authentication middleware for better security\n\nContext...',
    );
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      'plan-20260512-abcd1234',
      { toolName: 'write', input: { path: '.pi/artifacts/plan-20260512-abcd1234.md' } },
      dir,
      ctx,
    );
    strictEqual(result, 'plan-20260512-refactor-authentication-middleware-for-better-security');
    strictEqual(existsSync(join(dir, '.pi', 'artifacts', 'plan-20260512-abcd1234.md')), false);
    strictEqual(
      existsSync(
        join(dir, '.pi', 'artifacts', 'plan-20260512-refactor-authentication-middleware-for-better-security.md'),
      ),
      true,
    );
    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('Plan renamed to'));
  });
});

test('maybeRenamePlanArtifact: returns undefined when topic slug matches current', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.pi', 'artifacts'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'artifacts', 'plan-20260512-refactor.md'), 'Refactor\n\nContext...');
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      'plan-20260512-refactor',
      { toolName: 'write', input: { path: '.pi/artifacts/plan-20260512-refactor.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('maybeRenamePlanArtifact: returns undefined when no topic found', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.pi', 'artifacts'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'artifacts', 'plan-20260512-abcd1234.md'), '\n\n!!!   \n');
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      'plan-20260512-abcd1234',
      { toolName: 'write', input: { path: '.pi/artifacts/plan-20260512-abcd1234.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('maybeRenamePlanArtifact: ignores when currentPlanSlug undefined', () => {
  withTempDir((dir) => {
    const ctx = createExtensionContext();
    const result = maybeRenamePlanArtifact(
      true,
      undefined,
      { toolName: 'write', input: { path: '.pi/artifacts/plan-20260512-abcd1234.md' } },
      dir,
      ctx,
    );
    strictEqual(result, undefined);
  });
});

test('tool_call handler: parse failure with user confirm allows', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');
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

test('tool_call handler: parse failure with user reject blocks', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');
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

test('tool_call handler: destructive command blocks without prompt', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');
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

test('tool_call handler: emits harness:block for edit block', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const emitted: unknown[] = [];
  harness.eventBus.on('harness:block', (data) => emitted.push(data));

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

test('tool_call handler: emits harness:block for write block', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const emitted: unknown[] = [];
  harness.eventBus.on('harness:block', (data) => emitted.push(data));

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

test('tool_call handler: emits harness:block for bash block', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const emitted: unknown[] = [];
  harness.eventBus.on('harness:block', (data) => emitted.push(data));

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

test('tool_call handler: parse failure rejection emits harness:block', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const emitted: unknown[] = [];
  harness.eventBus.on('harness:block', (data) => emitted.push(data));

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

test('tool_call handler: allowed tool does not emit harness:block', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const emitted: unknown[] = [];
  harness.eventBus.on('harness:block', (data) => emitted.push(data));

  const { results } = await harness.emitEvent('tool_call', {
    toolName: 'read',
    input: { path: 'src/index.ts' },
    toolCallId: 'call-read-1',
  });

  strictEqual(results[0], undefined);
  strictEqual(emitted.length, 0);
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
  const harness = await createPiTestHarness(planModeExtension, '/project');

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
  strictEqual(msg.display, true);
  strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
  strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[1], 'warning');
});

test('input handler: blocks commit message in plan mode', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
  harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;

  const { results, ctx } = await harness.emitEvent('input', { text: 'COMMIT changes' });

  strictEqual((results[0] as { action: string }).action, 'handled');
  strictEqual(sendMessageSpy.mock.callCount(), 1);
  strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
});

test('input handler: allows non-blocked text in plan mode', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

  const sendMessageSpy = mock.fn(() => {}) as unknown as Mock<typeof harness.runtime.sendMessage>;
  harness.runtime.sendMessage = sendMessageSpy as unknown as typeof harness.runtime.sendMessage;

  const { results, ctx } = await harness.emitEvent('input', { text: 'what is the plan?' });

  strictEqual((results[0] as { action: string }).action, 'continue');
  strictEqual(sendMessageSpy.mock.callCount(), 0);
  strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 0);
});

test('input handler: allows blocked text when plan mode is disabled', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

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

test('toggle sends visible message when enabling plan mode', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

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
  strictEqual(onMsg.display, true);
  ok(onMsg.content.includes('enabled'));
});

test('toggle sends visible message when disabling plan mode', async () => {
  const harness = await createPiTestHarness(planModeExtension, '/project');

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
  strictEqual(offMsg.display, true);
  ok(offMsg.content.includes('disabled'));
});
