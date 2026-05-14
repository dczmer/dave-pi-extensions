import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import errorLoggerExtension from '../../../extensions/error-logger/index.ts';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-errlog-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createMockPi(overrides?: { flagValue?: string; sessionFile?: string }) {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
  const commands: Record<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const flags: Record<string, { description?: string; type: string; default?: unknown }> = {};
  const eventBusListeners: Record<string, Array<(data: unknown) => void>> = {};
  const flagValues: Record<string, unknown> = {};
  if (overrides?.flagValue !== undefined) {
    flagValues['error-log-path'] = overrides.flagValue;
  }

  const pi = {
    registerFlag: (name: string, options: { description?: string; type: string; default?: unknown }) => {
      flags[name] = options;
      if (options.default !== undefined && !(name in flagValues)) {
        flagValues[name] = options.default;
      }
    },
    registerCommand: (
      name: string,
      options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands[name] = options;
    },
    getFlag: (name: string) => flagValues[name],
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      (handlers[event] ??= []).push(handler);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of eventBusListeners[channel] ?? []) {
          listener(data);
        }
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        (eventBusListeners[channel] ??= []).push(handler);
        return () => {
          const idx = eventBusListeners[channel]?.indexOf(handler) ?? -1;
          if (idx >= 0) eventBusListeners[channel]!.splice(idx, 1);
        };
      },
    },
    _handlers: handlers,
    _commands: commands,
    _flags: flags,
    _eventBusListeners: eventBusListeners,
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, flags, eventBusListeners };
}

function createMockCtx(sessionFile?: string) {
  const notifications: Array<{ message: string; type?: string | undefined }> = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionFile: () => sessionFile ?? undefined,
    },
    _notifications: notifications,
  };
  return ctx as typeof ctx & ExtensionContext;
}

test('registers flag, command, and handlers', () => {
  const { pi, handlers, commands, flags } = createMockPi();
  errorLoggerExtension(pi);

  ok(flags['error-log-path']);
  ok(commands['error-log']);
  ok(handlers['tool_execution_start']);
  ok(handlers['tool_execution_end']);
  ok(handlers['session_shutdown']);
});

test('tool_execution_end logs error and stashed args', async () => {
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, handlers } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx('/fake/session.json');

    const startHandler = handlers['tool_execution_start']![0]!;
    const endHandler = handlers['tool_execution_end']![0]!;

    await startHandler({ toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls /bad' } }, ctx);
    await endHandler(
      {
        toolCallId: 'call-1',
        toolName: 'bash',
        result: 'ls: cannot access /bad: No such file or directory\n\nCommand exited with code 1',
        isError: true,
      },
      ctx,
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
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, handlers } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx();

    const startHandler = handlers['tool_execution_start']![0]!;
    await startHandler({ toolCallId: 'call-2', toolName: 'bash', args: { command: 'rm -rf /' } }, ctx);

    // emit block event
    pi.events.emit('harness:block', {
      toolCallId: 'call-2',
      tool: 'bash',
      extension: 'pi-gate',
      reason: 'Blocked by pi-gate',
    });

    // try to log same id via execution end
    const endHandler = handlers['tool_execution_end']![0]!;
    await endHandler({ toolCallId: 'call-2', toolName: 'bash', result: 'Blocked by pi-gate', isError: true }, ctx);

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
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, handlers } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx();
    const endHandler = handlers['tool_execution_end']![0]!;
    await endHandler(
      {
        toolCallId: 'call-3',
        toolName: 'bash',
        result: 'slow output\n\nCommand timed out after 30000ms',
        isError: true,
      },
      ctx,
    );

    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    strictEqual(entry.category, 'timeout');
    strictEqual(entry.outputPreview, 'slow output');
  });
});

test('aborted category detected', async () => {
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, handlers } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx();
    const endHandler = handlers['tool_execution_end']![0]!;
    await endHandler(
      {
        toolCallId: 'call-4',
        toolName: 'bash',
        result: 'partial\n\nCommand aborted by signal',
        isError: true,
      },
      ctx,
    );

    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    strictEqual(entry.category, 'aborted');
    strictEqual(entry.outputPreview, 'partial');
  });
});

test('non-error tool_execution_end is ignored', async () => {
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, handlers } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx();
    const endHandler = handlers['tool_execution_end']![0]!;
    await endHandler({ toolCallId: 'call-5', toolName: 'bash', result: 'ok', isError: false }, ctx);

    strictEqual(existsSync(logPath), false);
  });
});

test('command shows count and path', async () => {
  withTempDir(async (dir) => {
    const logPath = join(dir, 'errors.jsonl');
    const { pi, commands } = createMockPi({ flagValue: logPath });
    errorLoggerExtension(pi);

    const ctx = createMockCtx();
    const cmdHandler = commands['error-log']!.handler;
    await cmdHandler('', ctx);

    strictEqual(ctx._notifications.length, 1);
    ok(ctx._notifications[0]!.message.includes('0 entries'));
    ok(ctx._notifications[0]!.message.includes(logPath));
  });
});

test('session_shutdown unsubscribes event bus', async () => {
  const { pi, handlers, eventBusListeners } = createMockPi();
  errorLoggerExtension(pi);

  const shutdownHandler = handlers['session_shutdown']![0]!;
  await shutdownHandler({}, {});

  strictEqual(eventBusListeners['harness:block']?.length ?? 0, 0);
});
