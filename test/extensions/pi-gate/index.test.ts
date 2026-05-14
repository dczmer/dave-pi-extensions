import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piGateExtension from '../../../extensions/pi-gate/index.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';
import { createUIContext } from '../../utils/pi-context.ts';
import { mock } from 'node:test';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('blocks disallowed bash command and emits harness:block', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted: unknown[] = [];
    harness.eventBus.on('harness:block', (data) => emitted.push(data));

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
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted: unknown[] = [];
    harness.eventBus.on('harness:block', (data) => emitted.push(data));

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
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const harness = await createPiTestHarness(piGateExtension, dir);

    const emitted: unknown[] = [];
    harness.eventBus.on('harness:block', (data) => emitted.push(data));

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
