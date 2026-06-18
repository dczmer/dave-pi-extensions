import { strictEqual, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { checkFileAccess } from '../../../extensions/pi-gate/file-access.ts';
import { approveExternal, resetSessionState } from '../../../extensions/pi-gate/session.ts';
import { withTempDir } from '../../utils/temp-dir.ts';
import { createQueuedUIContext } from '../../utils/pi-context.ts';
import { createConfigResult } from './utils/config.ts';

test('project file allowed with empty deny list', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('src/main.ts', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file allowed when in config externalAllow', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: ['/tmp/*'] },
    project: { bashAllow: [], externalAllow: ['/tmp/*'] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('/tmp/foo.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file allowed when in session approved list', async () => {
  resetSessionState();
  approveExternal('/tmp/bar.txt');
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('/tmp/bar.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file approved by user and persisted to project config', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('/xyz-custom-path/*');
    ctx.queueSelect('Project');

    const result = await checkFileAccess('/xyz-custom-path/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, ['/xyz-custom-path/*']);

    const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: [], externalAllow: ['/xyz-custom-path/*'] });
  });
});

test('external file approved by user and persisted to global config', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('/abc-global-test/*');
    ctx.queueSelect('Global');

    const result = await checkFileAccess('/abc-global-test/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, []);
    deepStrictEqual(configResult.global.externalAllow, ['/abc-global-test/*']);

    const saved = JSON.parse(readFileSync(globalPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: [], externalAllow: ['/abc-global-test/*'] });
  });
});

test('external file approved by user but not persisted', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('/def-skip-test/*');
    ctx.queueSelect('No');

    const result = await checkFileAccess('/def-skip-test/foo.txt', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.externalAllow, []);

    strictEqual(existsSync(projectPath), false);
    strictEqual(existsSync(globalPath), false);
  });
});

test('external file denied by user at prompt', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueEditor(null);

  const result = await checkFileAccess('/etc/passwd', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('merged config includes both global and project patterns', async () => {
  const configResult = createConfigResult({
    merged: {
      bashAllow: [],
      externalAllow: ['/global/*', '/project/*'],
    },
    global: { bashAllow: [], externalAllow: ['/global/*'] },
    project: { bashAllow: [], externalAllow: ['/project/*'] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('/global/file.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});
