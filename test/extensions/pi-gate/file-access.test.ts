import { strictEqual, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { type ConfigResult } from '../../../extensions/pi-gate/config.ts';
import { checkFileAccess } from '../../../extensions/pi-gate/file-access.ts';
import { approveExternal, resetSessionState } from '../../../extensions/pi-gate/session.ts';

function createMockCtx() {
  const editorQueue: (string | null)[] = [];
  const selectQueue: (string | null)[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const ctx = {
    ui: {
      editor: () => Promise.resolve(editorQueue.shift() ?? undefined),
      select: <T extends string>() => Promise.resolve((selectQueue.shift() ?? 'project') as T),
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    _notifications: notifications,
    queueEditor: (v: string | null) => editorQueue.push(v),
    queueSelect: (v: string | null) => selectQueue.push(v),
  };

  return ctx as typeof ctx & Parameters<typeof checkFileAccess>[3];
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const empty = () => ({
    bashAllow: [] as string[],
    externalAllow: [] as string[],
    projectDeny: [] as string[],
  });
  return {
    merged: { ...empty(), ...(overrides?.merged || {}) },
    global: { ...empty(), ...(overrides?.global || {}) },
    project: { ...empty(), ...(overrides?.project || {}) },
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    ...overrides,
  };
}

test('project file allowed with empty deny list', async () => {
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  const result = await checkFileAccess('src/main.ts', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('project file allowed when not matching deny pattern', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [], projectDeny: ['*.secret'] },
    project: { bashAllow: [], externalAllow: [], projectDeny: ['*.secret'] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkFileAccess('src/main.ts', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file allowed when in config externalAllow', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: ['/tmp/*'], projectDeny: [] },
    project: { bashAllow: [], externalAllow: ['/tmp/*'], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkFileAccess('/tmp/foo.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file allowed when in session approved list', async () => {
  resetSessionState();
  approveExternal('/tmp/bar.txt');
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  const result = await checkFileAccess('/tmp/bar.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file approved by user and persisted to project config', async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueEditor('/xyz-custom-path/*');
    ctx.queueSelect('Project');

    const result = await checkFileAccess('/xyz-custom-path/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, ['/xyz-custom-path/*']);

    const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: [], externalAllow: ['/xyz-custom-path/*'], projectDeny: [] });
  });
});

test('external file approved by user and persisted to global config', async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueEditor('/abc-global-test/*');
    ctx.queueSelect('Global');

    const result = await checkFileAccess('/abc-global-test/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, []);
    deepStrictEqual(configResult.global.externalAllow, ['/abc-global-test/*']);

    const saved = JSON.parse(readFileSync(globalPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: [], externalAllow: ['/abc-global-test/*'], projectDeny: [] });
  });
});

test('external file approved by user but not persisted', async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueEditor('/def-skip-test/*');
    ctx.queueSelect('No');

    const result = await checkFileAccess('/def-skip-test/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, []);

    strictEqual(existsSync(projectPath), false);
    strictEqual(existsSync(globalPath), false);
  });
});

test('project file blocked by exact deny pattern', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [], projectDeny: ['secret.txt'] },
    project: { bashAllow: [], externalAllow: [], projectDeny: ['secret.txt'] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkFileAccess('secret.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
  strictEqual(ctx._notifications.length, 1);
  strictEqual(ctx._notifications[0]!.level, 'warning');
});

test('project file blocked by glob deny pattern', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [], projectDeny: ['*.secret'] },
    project: { bashAllow: [], externalAllow: [], projectDeny: ['*.secret'] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkFileAccess('foo.secret', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('external file denied by user at prompt', async () => {
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  ctx.queueEditor(null);

  const result = await checkFileAccess('/etc/passwd', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('merged config includes both global and project patterns', async () => {
  const configResult = createConfigResult({
    merged: {
      bashAllow: [],
      externalAllow: ['/global/*', '/project/*'],
      projectDeny: [],
    },
    global: { bashAllow: [], externalAllow: ['/global/*'], projectDeny: [] },
    project: { bashAllow: [], externalAllow: ['/project/*'], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkFileAccess('/global/file.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});
