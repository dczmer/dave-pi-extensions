import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultLogPath,
  buildEntry,
  writeEntry,
  readEntries,
  countEntries,
  capText,
  detectCategory,
  REASON_CAP,
  TRUNCATED_MARKER,
} from '../../../extensions/error-logger/logger.ts';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-errlog-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('getDefaultLogPath returns path in home', () => {
  const path = getDefaultLogPath();
  ok(path.includes('.pi/agent/harness-errors.jsonl'));
});

test('capText returns short text unchanged', () => {
  strictEqual(capText('short'), 'short');
});

test('capText truncates long text', () => {
  const long = 'a'.repeat(REASON_CAP + 100);
  const result = capText(long);
  strictEqual(result.length, REASON_CAP + TRUNCATED_MARKER.length);
  ok(result.endsWith(TRUNCATED_MARKER));
});

test('detectCategory: empty reason returns execution', () => {
  strictEqual(detectCategory(), 'execution');
});

test('detectCategory: timeout heuristic', () => {
  strictEqual(detectCategory('Command timed out after 5000ms'), 'timeout');
});

test('detectCategory: aborted heuristic', () => {
  strictEqual(detectCategory('Command aborted by user'), 'aborted');
});

test('detectCategory: generic error returns execution', () => {
  strictEqual(detectCategory('file not found'), 'execution');
});

test('buildEntry creates entry without reason', () => {
  const entry = buildEntry(
    '2024-01-01T00:00:00Z',
    undefined,
    'bash',
    'call-1',
    { command: 'ls' },
    'execution',
    'execution',
  );
  strictEqual(entry.ts, '2024-01-01T00:00:00Z');
  strictEqual(entry.tool, 'bash');
  strictEqual(entry.callId, 'call-1');
  strictEqual(entry.category, 'execution');
  strictEqual(entry.source, 'execution');
  strictEqual('reason' in entry, false);
});

test('buildEntry caps reason', () => {
  const longReason = 'x'.repeat(REASON_CAP + 10);
  const entry = buildEntry(
    '2024-01-01T00:00:00Z',
    undefined,
    'bash',
    'call-1',
    {},
    'execution',
    'execution',
    longReason,
  );
  ok(entry.reason!.endsWith(TRUNCATED_MARKER));
});

test('writeEntry creates directories and appends', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'nested', 'errors.jsonl');
    strictEqual(existsSync(logPath), false);

    const entry = buildEntry('2024-01-01T00:00:00Z', undefined, 'bash', 'call-1', {}, 'execution', 'execution');
    const ok1 = writeEntry(logPath, entry);
    strictEqual(ok1, true);
    strictEqual(existsSync(logPath), true);

    const entries = readEntries(logPath);
    strictEqual(entries.length, 1);
    strictEqual(entries[0]!.tool, 'bash');
  });
});

test('writeEntry appends multiple lines', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'errors.jsonl');
    writeEntry(logPath, buildEntry('2024-01-01T00:00:00Z', undefined, 'bash', 'c1', {}, 'execution', 'execution'));
    writeEntry(logPath, buildEntry('2024-01-01T00:00:01Z', undefined, 'read', 'c2', {}, 'blocked', 'pi-gate'));

    const entries = readEntries(logPath);
    strictEqual(entries.length, 2);
    strictEqual(entries[0]!.callId, 'c1');
    strictEqual(entries[1]!.callId, 'c2');
  });
});

test('readEntries skips malformed lines', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'errors.jsonl');
    writeEntry(logPath, buildEntry('2024-01-01T00:00:00Z', undefined, 'bash', 'c1', {}, 'execution', 'execution'));
    // inject malformed line manually
    appendFileSync(logPath, 'not-json\n', 'utf-8');
    writeEntry(logPath, buildEntry('2024-01-01T00:00:01Z', undefined, 'read', 'c2', {}, 'blocked', 'pi-gate'));

    const entries = readEntries(logPath);
    strictEqual(entries.length, 2);
  });
});

test('countEntries returns zero for missing file', () => {
  withTempDir((dir) => {
    strictEqual(countEntries(join(dir, 'missing.jsonl')), 0);
  });
});

test('countEntries matches readEntries length', () => {
  withTempDir((dir) => {
    const logPath = join(dir, 'errors.jsonl');
    writeEntry(logPath, buildEntry('2024-01-01T00:00:00Z', undefined, 'bash', 'c1', {}, 'execution', 'execution'));
    strictEqual(countEntries(logPath), 1);
  });
});
