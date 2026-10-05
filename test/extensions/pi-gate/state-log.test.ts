import { strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { withTempDir } from '../../../test/utils/temp-dir.ts';
import {
  STATE_FILE_ENV,
  applyRecord,
  getSharedView,
  initSharedState,
  isSharedStateActive,
  parseRecords,
  persistRecord,
  refreshSharedState,
  resolveStateFile,
  setStateLogOverride,
  type LogView,
  type StateLogRecord,
} from '../../../extensions/pi-gate/state-log.ts';

/** Drop any cached handle/override so each test starts cold. */
function cold(): void {
  setStateLogOverride(undefined);
}

/** Spawn a process that exits immediately and return its (now dead) pid. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  if (typeof result.pid !== 'number') throw new Error('spawnSync did not report a pid');
  return result.pid;
}

function record(rec: Partial<StateLogRecord> & Pick<StateLogRecord, 'op'>): StateLogRecord {
  return { v: 1, ts: Date.now(), pid: process.pid, ...rec };
}

function writeLog(file: string, records: StateLogRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
}

test('initSharedState creates dir + file with init record', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'nested', 'state.jsonl');
    setStateLogOverride(file);

    initSharedState(dir);

    strictEqual(existsSync(file), true);
    const recs = parseRecords(readFileSync(file, 'utf-8'));
    strictEqual(recs.length, 1);
    strictEqual(recs.at(0)?.op, 'init');
    strictEqual(recs.at(0)?.pid, process.pid);
    strictEqual(isSharedStateActive(), true);
  }));

test('initSharedState is idempotent', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);

    initSharedState(dir);
    const sizeAfterFirst = readFileSync(file, 'utf-8');
    initSharedState(dir);

    strictEqual(readFileSync(file, 'utf-8'), sizeAfterFirst);
  }));

test('persistRecord + refresh round-trips in one process', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    setStateLogOverride(join(dir, 'state.jsonl'));
    initSharedState(dir);

    persistRecord({ op: 'approve-bash', pattern: 'npm run *' });
    persistRecord({ op: 'approve-external', pattern: '/nix/store' });
    persistRecord({ op: 'toggle', guard: 'bash', enabled: false });

    const view = getSharedView();
    strictEqual(view.bash.has('npm run *'), true);
    strictEqual(view.external.has('/nix/store'), true);
    strictEqual(view.bashEnabled, false);
    strictEqual(view.externalEnabled, undefined);
  }));

test('fresh handle on the same file sees earlier records (child-process view)', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);
    persistRecord({ op: 'approve-bash', pattern: 'npm run *' });
    persistRecord({ op: 'toggle', guard: 'external', enabled: false });

    // Simulate a subagent child: fresh handle on the same file. The init
    // record's pid is this same (live) process, so the log is adopted.
    setStateLogOverride(undefined);
    setStateLogOverride(file);
    initSharedState(dir);

    const view = getSharedView();
    strictEqual(view.bash.has('npm run *'), true);
    strictEqual(view.externalEnabled, false);
  }));

test('interleaved foreign append is not lost (bug-1 regression)', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir); // refresh: offset now past existing records

    // A sibling process appends between our refresh and our append.
    appendFileSync(file, JSON.stringify(record({ op: 'approve-bash', pattern: 'foreign *', pid: 999999 })) + '\n');

    persistRecord({ op: 'approve-external', pattern: '/foreign/path' });

    const view = getSharedView();
    strictEqual(view.bash.has('foreign *'), true, 'foreign record must survive our append');
    strictEqual(view.external.has('/foreign/path'), true);
  }));

test('stale log with dead init pid is truncated and re-initialized', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    writeLog(file, [record({ op: 'init', pid: deadPid() }), record({ op: 'approve-bash', pattern: 'stale *' })]);
    setStateLogOverride(file);

    initSharedState(dir, false); // fresh process, nothing inherited

    const recs = parseRecords(readFileSync(file, 'utf-8'));
    strictEqual(recs.length, 1);
    strictEqual(recs.at(0)?.op, 'init');
    strictEqual(recs.at(0)?.pid, process.pid);
    strictEqual(getSharedView().bash.has('stale *'), false);
  }));

test('live-sibling approvals are still wiped (bug-2 characterization, accepted)', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    // Init pid is dead, but a later record comes from a live pid (a sibling
    // session that adopted the log). Reaping checks only the init pid, so the
    // truncation still happens — this documents the accepted limitation.
    writeLog(file, [
      record({ op: 'init', pid: deadPid() }),
      record({ op: 'approve-bash', pattern: 'sibling *' }), // pid: current (live)
    ]);
    setStateLogOverride(file);

    initSharedState(dir, false);

    const recs = parseRecords(readFileSync(file, 'utf-8'));
    strictEqual(recs.length, 1);
    strictEqual(getSharedView().bash.has('sibling *'), false);
  }));

test('inherited env prevents truncation of a dead-pid log (child adopts as-is)', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    writeLog(file, [record({ op: 'init', pid: deadPid() }), record({ op: 'approve-bash', pattern: 'inherited *' })]);
    setStateLogOverride(file);

    initSharedState(dir, true); // subagent child: would never truncate

    const recs = parseRecords(readFileSync(file, 'utf-8'));
    strictEqual(recs.length, 2);
    strictEqual(getSharedView().bash.has('inherited *'), true);
  }));

test('file shrunk below reader offset resets the view', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);
    persistRecord({ op: 'approve-bash', pattern: 'gone *' });
    strictEqual(getSharedView().bash.has('gone *'), true);

    // External truncation (stale-reset by another session): file shrinks.
    writeLog(file, [record({ op: 'init' })]);

    const view = getSharedView();
    strictEqual(view.bash.has('gone *'), false);
  }));

test('partial trailing line is buffered until completed', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    const line = JSON.stringify(record({ op: 'approve-bash', pattern: 'partial *' }));
    appendFileSync(file, line.slice(0, 12)); // writer mid-append
    strictEqual(getSharedView().bash.has('partial *'), false);

    appendFileSync(file, line.slice(12) + '\n');
    strictEqual(getSharedView().bash.has('partial *'), true);
  }));

test('malformed lines are skipped', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    appendFileSync(file, 'this is not json\n');
    appendFileSync(file, '{"v":2,"op":"approve-bash","pattern":"wrong-version *"}\n');
    persistRecord({ op: 'approve-bash', pattern: 'valid *' });

    const view = getSharedView();
    strictEqual(view.bash.has('valid *'), true);
    strictEqual(view.bash.has('wrong-version *'), false);
    strictEqual(view.bash.size, 1);
  }));

test('last toggle record wins on replay', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    persistRecord({ op: 'toggle', guard: 'bash', enabled: false });
    persistRecord({ op: 'toggle', guard: 'bash', enabled: true });
    persistRecord({ op: 'toggle', guard: 'external', enabled: false });

    const view = getSharedView();
    strictEqual(view.bashEnabled, true);
    strictEqual(view.externalEnabled, false);
  }));

test('applyRecord folds records into a provided view', () => {
  const view: LogView = { bash: new Set(), external: new Set(), bashEnabled: undefined, externalEnabled: undefined };
  applyRecord(view, record({ op: 'approve-bash', pattern: 'a *' }));
  applyRecord(view, record({ op: 'toggle', guard: 'bash', enabled: false }));
  strictEqual(view.bash.has('a *'), true);
  strictEqual(view.bashEnabled, false);
});

test('all state-log functions no-op when never initialized', () => {
  cold();
  strictEqual(isSharedStateActive(), false);
  persistRecord({ op: 'approve-bash', pattern: 'noop *' }); // must not throw
  refreshSharedState();
  const view = getSharedView();
  strictEqual(view.bash.size, 0);
  strictEqual(view.bashEnabled, undefined);
});

test('resolveStateFile uses the cwd-keyed tmpdir path by default', () =>
  withTempDir('pi-gate-', (dir) => {
    cold();
    strictEqual(resolveStateFile(dir).includes('pi-gate-'), true);
    strictEqual(STATE_FILE_ENV, 'PI_GATE_STATE_FILE');
  }));
