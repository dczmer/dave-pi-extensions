import { strictEqual, deepStrictEqual } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { checkFileAccess } from '../../../extensions/pi-gate/file-access.ts';
import {
  approveExternalPattern,
  isExternalApproved,
  resetSessionState,
  setExternalEnabled,
} from '../../../extensions/pi-gate/session.ts';
import { withTempDir } from '../../utils/temp-dir.ts';
import { createQueuedUIContext, createExtensionContext, createUIContext } from '../../utils/pi-context.ts';
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
  approveExternalPattern('/tmp/bar.txt');
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('/tmp/bar.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('external file approved by user and persisted to project config', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'pi-gate.json');
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
    const projectPath = join(dir, '.pi', 'pi-gate.json');
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
    const projectPath = join(dir, '.pi', 'pi-gate.json');
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

test('config externalAllow directory entry allows descendants without prompt', async () => {
  const configResult = createConfigResult({ merged: { bashAllow: [], externalAllow: ['/nix/blahblah'] } });
  // Empty queues: any prompt would resolve to denial, so `true` proves silence.
  const ctx = createQueuedUIContext();
  const result = await checkFileAccess('/nix/blahblah/sub/deep.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('regression: "No" (not persisted) still whitelists the pattern session-wide', async () => {
  resetSessionState();
  const configResult = createConfigResult();

  const approvingCtx = createQueuedUIContext();
  approvingCtx.queueEditor('/nix/blahblah/*'); // user accepts suggested glob
  approvingCtx.queueSelect('No'); // user declines persistence

  const first = await checkFileAccess('/nix/blahblah/foo', '/fake/cwd', configResult, approvingCtx);
  strictEqual(first, true);

  // Subsequent accesses covered by the pattern must NOT prompt.
  const silentCtx = createQueuedUIContext();
  strictEqual(await checkFileAccess('/nix/blahblah/bar', '/fake/cwd', configResult, silentCtx), true);
  strictEqual(await checkFileAccess('/nix/blahblah/sub/deep.txt', '/fake/cwd', configResult, silentCtx), true);

  // Unrelated paths must still prompt (empty queue → editor returns undefined → denied).
  const unrelatedCtx = createQueuedUIContext();
  strictEqual(await checkFileAccess('/nix/other/x', '/fake/cwd', configResult, unrelatedCtx), false);
});

test('tilde and relative patterns are normalized before session storage', async () => {
  resetSessionState();
  const configResult = createConfigResult();

  const ctx = createQueuedUIContext();
  ctx.queueEditor('~/notes/*');
  ctx.queueSelect('No');

  const result = await checkFileAccess('~/notes/today.md', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);

  // The stored pattern must be normalized against the real home directory.
  strictEqual(isExternalApproved(join(homedir(), 'notes', 'upcoming.md')), true);
});

test('config absolute externalAllow entry covers a tilde-supplied path', async () => {
  resetSessionState();
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [join(homedir(), '.pi')] },
    global: { bashAllow: [], externalAllow: [join(homedir(), '.pi')] },
  });
  // Empty queues: any prompt would resolve to denial, so `true` proves silence.
  const ctx = createQueuedUIContext();
  strictEqual(await checkFileAccess('~/.pi/agent/agents/reviewer.md', '/fake/cwd', configResult, ctx), true);
});

test('tilde pattern typed at the prompt is persisted normalized and absolute', async () => {
  resetSessionState();
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('~/.pi');
    ctx.queueSelect('Project');

    strictEqual(await checkFileAccess('~/.pi/agent/foo.json', dir, configResult, ctx), true);

    // Persisted verbatim, a `~/.pi` entry would be dead config.
    const expected = join(homedir(), '.pi');
    deepStrictEqual(configResult.project.externalAllow, [expected]);
    strictEqual(configResult.merged.externalAllow.includes(expected), true);

    const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: [], externalAllow: [expected] });

    // The entry is live for siblings in a later session, once reloaded.
    strictEqual(isExternalApproved(join(homedir(), '.pi', 'agent', 'bar.json')), true);
  });
});

test('prompt prefill shows a normalized absolute path, not the raw tool input', async () => {
  resetSessionState();
  const prefills: Array<string | undefined> = [];
  const ui = createUIContext({
    editor: mock.fn(async (_title: string, prefill?: string) => {
      prefills.push(prefill);
      return undefined;
    }) as unknown as ExtensionUIContext['editor'],
  });
  const ctx = createExtensionContext({ ui });

  const result = await checkFileAccess('~/.pi/agent/foo.json', '/fake/cwd', createConfigResult(), ctx);
  strictEqual(result, false);
  deepStrictEqual(prefills, [join(homedir(), '.pi', 'agent', 'foo.json')]);
});

test('external file allowed without prompting when external guard is disabled', async () => {
  resetSessionState();
  setExternalEnabled(false);
  try {
    const configResult = createConfigResult();
    const ctx = createQueuedUIContext();
    const result = await checkFileAccess('/etc/passwd', '/fake/cwd', configResult, ctx);
    strictEqual(result, true);
    strictEqual(ctx._notifications.length, 0);
  } finally {
    resetSessionState();
  }
});
