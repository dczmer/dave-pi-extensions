import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRunDir,
  resolveRunsRoot,
  RUNS_DIR_ENV,
  RUNS_RETENTION_DAYS,
  sweepOldRuns,
} from '../../../extensions/subagent/run-store.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

test('resolveRunsRoot honors the env override', () => {
  strictEqual(resolveRunsRoot({ [RUNS_DIR_ENV]: '/tmp/fake-runs' }), '/tmp/fake-runs');
});

test('resolveRunsRoot falls back to the agent dir', () => {
  const root = resolveRunsRoot({});
  ok(root.endsWith('subagent-runs'), root);
});

test('createRunDir creates a 0700 dir with a timestamp-name pattern', () => {
  withTempDir('subagent-runs-', (root) => {
    const now = new Date(2025, 0, 2, 3, 4, 5);
    const dir = createRunDir(root, 'my agent!', now);
    ok(existsSync(dir));
    strictEqual(statSync(dir).mode & 0o777, 0o700);
    // Sanitized agent name + 6-char random suffix ('my agent!' → 'my_agent_').
    ok(/^20250102-030405-my_agent_-[a-z0-9]{6}$/.test(dir.slice(root.length + 1)), dir);
  });
});

test('sweepOldRuns removes old dirs, keeps recent and non-matching ones', () => {
  withTempDir('subagent-runs-', (root) => {
    const now = new Date(2025, 5, 10, 12, 0, 0);
    const old = createRunDir(root, 'a', new Date(2025, 5, 1, 12, 0, 0)); // 9 days old
    const recent = createRunDir(root, 'b', new Date(2025, 5, 9, 12, 0, 0)); // 1 day old
    const notARun = join(root, 'misc-backup');
    mkdirSync(notARun);
    writeFileSync(join(root, 'stray-file'), 'x');

    const removed = sweepOldRuns(root, RUNS_RETENTION_DAYS, now);
    deepStrictEqual(removed, [old.slice(root.length + 1)]);
    ok(!existsSync(old));
    ok(existsSync(recent));
    ok(existsSync(notARun));
    ok(existsSync(join(root, 'stray-file')));
  });
});

test('sweepOldRuns tolerates a missing root', () => {
  deepStrictEqual(sweepOldRuns('/tmp/definitely-not-there-pi-subagent'), []);
});

test('sweepOldRuns ignores a non-matching dir name', () => {
  withTempDir('subagent-runs-', (root) => {
    mkdirSync(join(root, '20250102-nope-extra'));
    deepStrictEqual(sweepOldRuns(root, RUNS_RETENTION_DAYS, new Date(2026, 0, 1)), []);
    ok(existsSync(join(root, '20250102-nope-extra')));
  });
});
