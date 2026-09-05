import { strictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import piGateExtension from '../../../extensions/pi-gate/index.ts';
import { createPiTestHarness, captureEvents } from '../../utils/pi-harness.ts';
import { createUIContext } from '../../utils/pi-context.ts';
import { withTempDir } from '../../utils/temp-dir.ts';
import { resetSessionState, isBashEnabled, isExternalEnabled } from '../../../extensions/pi-gate/session.ts';

test('blocks disallowed bash command and emits harness:block', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'xyz-unknown-cmd arg' }, toolCallId: 'call-1' },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => false),
        }),
      },
    );

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    ok(result?.reason.includes('pi-gate'));

    strictEqual(emitted.length, 1);
    const data = emitted[0] as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-1');
    strictEqual(data.tool, 'bash');
    strictEqual(data.extension, 'pi-gate');
    strictEqual(data.reason, 'Blocked by pi-gate');
  });
});

test('blocks disallowed file access and emits harness:block', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'read', input: { path: '/etc/passwd' }, toolCallId: 'call-2' },
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
    strictEqual(data.toolCallId, 'call-2');
    strictEqual(data.tool, 'read');
    strictEqual(data.extension, 'pi-gate');
  });
});

test('allowed command does not emit harness:block', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted = captureEvents(harness, 'harness:block');

    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'ls -la' }, toolCallId: 'call-3' },
      {
        ui: createUIContext({
          confirm: mock.fn(async () => false),
        }),
      },
    );

    strictEqual(results[0], undefined);
    strictEqual(emitted.length, 0);
  });
});

test('registers the /pi-gate command', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    ok(harness.listRegisteredCommands().includes('pi-gate'));
  });
});

test('/pi-gate bash off allows unknown bash commands without prompting', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    resetSessionState();
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    await harness.command('pi-gate').execute('bash off');
    strictEqual(isBashEnabled(), false);

    const emitted = captureEvents(harness, 'harness:block');
    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'xyz-unknown-cmd arg' }, toolCallId: 'call-4' },
      { ui: createUIContext() },
    );

    strictEqual(results[0], undefined);
    strictEqual(emitted.length, 0);
    resetSessionState();
  });
});

test('/pi-gate bash off still gates external paths in file tools', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    resetSessionState();
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    await harness.command('pi-gate').execute('bash off');

    const emitted = captureEvents(harness, 'harness:block');
    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'read', input: { path: '/etc/passwd' }, toolCallId: 'call-5' },
      { ui: createUIContext() }, // editor returns undefined → pattern rejected
    );

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    strictEqual(emitted.length, 1);
    resetSessionState();
  });
});

test('/pi-gate external off allows external file access without prompting', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    resetSessionState();
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    await harness.command('pi-gate').execute('external off');
    strictEqual(isExternalEnabled(), false);

    const emitted = captureEvents(harness, 'harness:block');
    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'read', input: { path: '/etc/passwd' }, toolCallId: 'call-6' },
      { ui: createUIContext() },
    );

    strictEqual(results[0], undefined);
    strictEqual(emitted.length, 0);
    resetSessionState();
  });
});

test('/pi-gate external off still gates bash command patterns', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    resetSessionState();
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    await harness.command('pi-gate').execute('external off');

    const emitted = captureEvents(harness, 'harness:block');
    const { results } = await harness.emitEvent(
      'tool_call',
      { toolName: 'bash', input: { command: 'xyz-unknown-cmd arg' }, toolCallId: 'call-7' },
      { ui: createUIContext() }, // editor returns undefined → pattern rejected
    );

    const result = results[0] as { block: true; reason: string } | undefined;
    strictEqual(result?.block, true);
    strictEqual(emitted.length, 1);
    resetSessionState();
  });
});

test('/pi-gate with no args applies the picker selection', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    resetSessionState();
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const select = mock.fn(async () => 'external off');
    await harness.command('pi-gate').execute('', { ui: createUIContext({ select }) });

    strictEqual(select.mock.calls.length, 1);
    strictEqual(isExternalEnabled(), false);
    strictEqual(isBashEnabled(), true);
    resetSessionState();
  });
});
