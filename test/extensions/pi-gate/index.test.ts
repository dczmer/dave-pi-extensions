import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piGateExtension from '../../../extensions/pi-gate/index.ts';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createMockCtx(cwd: string) {
  const notifications: Array<{ message: string; level: string }> = [];
  const confirmQueue: boolean[] = [];
  const editorQueue: (string | null)[] = [];
  const selectQueue: (string | null)[] = [];

  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      confirm: () => Promise.resolve(confirmQueue.shift() ?? false),
      editor: () => Promise.resolve(editorQueue.shift() ?? undefined),
      select: <T extends string>() => Promise.resolve((selectQueue.shift() ?? 'project') as T),
    },
    cwd,
    _notifications: notifications,
    queueConfirm: (v: boolean) => confirmQueue.push(v),
    queueEditor: (v: string | null) => editorQueue.push(v),
    queueSelect: (v: string | null) => selectQueue.push(v),
  };
  return ctx as typeof ctx & ExtensionContext;
}

function createMockPi() {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      (handlers[event] ??= []).push(handler);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
      on: () => () => {},
    },
    _handlers: handlers,
    _emitted: emitted,
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, emitted };
}

test('blocks disallowed bash command and emits harness:block', async () => {
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const { pi, handlers, emitted } = createMockPi();
    piGateExtension(pi);

    const ctx = createMockCtx(dir);
    ctx.queueConfirm(false);

    const handler = handlers['tool_call']![0]!;
    const result = (await handler(
      { toolName: 'bash', input: { command: 'xyz-unknown-cmd arg' }, toolCallId: 'call-1' },
      ctx,
    )) as { block: true; reason: string } | undefined;

    strictEqual(result?.block, true);
    ok(result?.reason.includes('pi-gate'));

    const blockEvent = emitted.find((e) => e.channel === 'harness:block');
    ok(blockEvent, 'harness:block event should be emitted');
    const data = blockEvent!.data as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-1');
    strictEqual(data.tool, 'bash');
    strictEqual(data.extension, 'pi-gate');
    strictEqual(data.reason, 'Blocked by pi-gate');
  });
});

test('blocks disallowed file access and emits harness:block', async () => {
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const { pi, handlers, emitted } = createMockPi();
    piGateExtension(pi);

    const ctx = createMockCtx(dir);
    ctx.queueConfirm(false);

    const handler = handlers['tool_call']![0]!;
    const result = (await handler({ toolName: 'read', input: { path: '/etc/passwd' }, toolCallId: 'call-2' }, ctx)) as
      | { block: true; reason: string }
      | undefined;

    strictEqual(result?.block, true);

    const blockEvent = emitted.find((e) => e.channel === 'harness:block');
    ok(blockEvent, 'harness:block event should be emitted');
    const data = blockEvent!.data as { toolCallId: string; tool: string; extension: string; reason: string };
    strictEqual(data.toolCallId, 'call-2');
    strictEqual(data.tool, 'read');
    strictEqual(data.extension, 'pi-gate');
  });
});

test('allowed command does not emit harness:block', async () => {
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
    const { pi, handlers, emitted } = createMockPi();
    piGateExtension(pi);

    const ctx = createMockCtx(dir);

    const handler = handlers['tool_call']![0]!;
    const result = await handler({ toolName: 'bash', input: { command: 'ls -la' }, toolCallId: 'call-3' }, ctx);

    strictEqual(result, undefined);
    strictEqual(emitted.filter((e) => e.channel === 'harness:block').length, 0);
  });
});
