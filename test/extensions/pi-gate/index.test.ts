import { strictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import piGateExtension from '../../../extensions/pi-gate/index.ts';
import { createPiTestHarness, captureEvents } from '../../utils/pi-harness.ts';
import { createUIContext } from '../../utils/pi-context.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

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
