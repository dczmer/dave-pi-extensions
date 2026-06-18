import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import {
  promptPattern,
  confirmAddToConfig,
  confirmAddToConfigWithTarget,
} from '../../../extensions/pi-gate/prompts.ts';
import { createQueuedUIContext } from '../../utils/pi-context.ts';

test('promptPattern returns edited value', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueEditor('/tmp/*');
  const result = await promptPattern('/tmp/test.txt', 'External path pattern', ctx);
  strictEqual(result, '/tmp/*');
});

test('promptPattern returns null when input cleared', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueEditor('');
  const result = await promptPattern('/tmp/test.txt', 'External path pattern', ctx);
  strictEqual(result, null);
});

test('promptPattern returns null on cancel', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueEditor(null);
  const result = await promptPattern('/tmp/test.txt', 'External path pattern', ctx);
  strictEqual(result, null);
});

test('confirmAddToConfig returns true when user selects Project', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('Project');
  const result = await confirmAddToConfig('bashAllow', ctx);
  strictEqual(result, true);
});

test('confirmAddToConfig returns true when user selects Global', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('Global');
  const result = await confirmAddToConfig('bashAllow', ctx);
  strictEqual(result, true);
});

test('confirmAddToConfig returns false when user selects No', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('No');
  const result = await confirmAddToConfig('bashAllow', ctx);
  strictEqual(result, false);
});

test('confirmAddToConfigWithTarget returns confirmed true and project target', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('Project');
  const result = await confirmAddToConfigWithTarget('bashAllow', ctx);
  strictEqual(result.confirmed, true);
  strictEqual(result.target, 'project');
});

test('confirmAddToConfigWithTarget returns confirmed true and global target', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('Global');
  const result = await confirmAddToConfigWithTarget('bashAllow', ctx);
  strictEqual(result.confirmed, true);
  strictEqual(result.target, 'global');
});

test('confirmAddToConfigWithTarget returns confirmed false when user selects No', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect('No');
  const result = await confirmAddToConfigWithTarget('bashAllow', ctx);
  strictEqual(result.confirmed, false);
  strictEqual(result.target, 'project'); // default fallback
});

test('confirmAddToConfigWithTarget returns confirmed false when select returns undefined (cancel)', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueSelect(null);
  const result = await confirmAddToConfigWithTarget('bashAllow', ctx);
  strictEqual(result.confirmed, false);
  strictEqual(result.target, 'project');
});

test('promptPattern trims whitespace from input', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueEditor('  /tmp/*  ');
  const result = await promptPattern('/tmp/test.txt', 'External path pattern', ctx);
  strictEqual(result, '/tmp/*');
});

test('promptPattern empty string after trim returns null', async () => {
  const ctx = createQueuedUIContext();
  ctx.queueEditor('   ');
  const result = await promptPattern('/tmp/test.txt', 'External path pattern', ctx);
  strictEqual(result, null);
});
