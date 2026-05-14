import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { test, type Mock } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import errorLoggerExtension from '../../../extensions/error-logger/index.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';
import { createSessionManagerStub } from '../../utils/pi-context.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-errlog-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('registers flag, command, and handlers', async () => {
  const harness = await createPiTestHarness(errorLoggerExtension);

  ok(harness.extension.flags.has('error-log-path'));
  ok(harness.extension.commands.has('error-log'));
  ok(harness.extension.handlers.has('tool_execution_start'));
  ok(harness.extension.handlers.has('tool_execution_end'));
  ok(harness.extension.handlers.has('session_shutdown'));
});

test('tool_execution_end logs error and stashed args', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    const sessionManager = createSessionManagerStub({ getSessionFile: () => '/fake/session.json' });

    await harness.emitEvent('tool_execution_start', {
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls /bad' },
    });

    await harness.emitEvent(
      'tool_execution_end',
      {
        toolCallId: 'call-1',
        toolName: 'bash',
        result: 'ls: cannot access /bad: No such file or directory\n\nCommand exited with code 1',
        isError: true,
      },
      { sessionManager },
    );

    const content = readFileSync(logPath, 'utf-8').trim();
    ok(content.length > 0);
    const entry = JSON.parse(content);
    strictEqual(entry.tool, 'bash');
    strictEqual(entry.callId, 'call-1');
    strictEqual(entry.category, 'execution');
    strictEqual(entry.source, 'execution');
    strictEqual(entry.reason, 'ls: cannot access /bad: No such file or directory\n\nCommand exited with code 1');
    strictEqual(entry.exitCode, 1);
    strictEqual(entry.outputPreview, 'ls: cannot access /bad: No such file or directory');
    strictEqual(entry.session, '/fake/session.json');
    deepStrictEqual(entry.input, { command: 'ls /bad' });
  });
});

test('harness:block logs blocked tool and deduplicates', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    await harness.emitEvent('tool_execution_start', {
      toolCallId: 'call-2',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
    });

    // Emit block event via shared event bus
    harness.eventBus.emit('harness:block', {
      toolCallId: 'call-2',
      tool: 'bash',
      extension: 'pi-gate',
      reason: 'Blocked by pi-gate',
    });

    // Try to log same id via execution end
    await harness.emitEvent(
      'tool_execution_end',
      {
        toolCallId: 'call-2',
        toolName: 'bash',
        result: 'Blocked by pi-gate',
        isError: true,
      },
      { sessionManager: createSessionManagerStub() },
    );

    const entries = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    strictEqual(entries.length, 1);
    strictEqual(entries[0]!.category, 'blocked');
    strictEqual(entries[0]!.source, 'pi-gate');
    strictEqual(entries[0]!.tool, 'bash');
  });
});

test('timeout category detected', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    await harness.emitEvent(
      'tool_execution_end',
      {
        toolCallId: 'call-3',
        toolName: 'bash',
        result: 'slow output\n\nCommand timed out after 30000ms',
        isError: true,
      },
      { sessionManager: createSessionManagerStub() },
    );

    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    strictEqual(entry.category, 'timeout');
    strictEqual(entry.outputPreview, 'slow output');
  });
});

test('aborted category detected', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    await harness.emitEvent(
      'tool_execution_end',
      {
        toolCallId: 'call-4',
        toolName: 'bash',
        result: 'partial\n\nCommand aborted by signal',
        isError: true,
      },
      { sessionManager: createSessionManagerStub() },
    );

    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    strictEqual(entry.category, 'aborted');
    strictEqual(entry.outputPreview, 'partial');
  });
});

test('non-error tool_execution_end is ignored', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    await harness.emitEvent(
      'tool_execution_end',
      {
        toolCallId: 'call-5',
        toolName: 'bash',
        result: 'ok',
        isError: false,
      },
      { sessionManager: createSessionManagerStub() },
    );

    strictEqual(existsSync(logPath), false);
  });
});

test('command shows count and path', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    const ctx = await harness.command('error-log').execute('');

    strictEqual((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.callCount(), 1);
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes('0 entries'));
    ok((ctx.ui.notify as Mock<typeof ctx.ui.notify>).mock.calls[0]!.arguments[0].includes(logPath));
  });
});

test('session_shutdown unsubscribes event bus', async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const harness = await createPiTestHarness(errorLoggerExtension);
    harness.runtime.flagValues.set('error-log-path', logPath);

    // Stash args and emit a block event before shutdown
    await harness.emitEvent('tool_execution_start', {
      toolCallId: 'call-shutdown-1',
      toolName: 'bash',
      args: { command: 'rm -rf /' },
    });
    harness.eventBus.emit('harness:block', {
      toolCallId: 'call-shutdown-1',
      tool: 'bash',
      extension: 'pi-gate',
      reason: 'Blocked by pi-gate',
    });

    ok(existsSync(logPath), 'Log should exist after first block event');

    // Shutdown
    await harness.emitEvent('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

    // Emit another block event after shutdown — should not be logged
    await harness.emitEvent('tool_execution_start', {
      toolCallId: 'call-shutdown-2',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    harness.eventBus.emit('harness:block', {
      toolCallId: 'call-shutdown-2',
      tool: 'bash',
      extension: 'pi-gate',
      reason: 'Blocked by pi-gate',
    });

    const entries = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    strictEqual(entries.length, 1);
    strictEqual(entries[0]!.callId, 'call-shutdown-1');
  });
});
