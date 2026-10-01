import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { loadSessionFolders } from '../../src/session-viewer/sessions.ts';
import { withTempDir } from '../utils/temp-dir.ts';

/**
 * Write a minimal session file (header only) whose `modified` falls back to
 * the header timestamp.
 */
function writeSession(dir: string, name: string, cwd: string, headerTimestamp: string): void {
  const header = { type: 'session', version: 3, id: name, timestamp: headerTimestamp, cwd };
  writeFileSync(join(dir, name), JSON.stringify(header) + '\n');
}

test('loadSessionFolders groups by cwd and sorts folders and sessions by recency', async () => {
  await withTempDir('sv-sessions-', async (root) => {
    const sourceDir = join(root, '--source--');
    const otherDir = join(root, '--other--');
    mkdirSync(sourceDir);
    mkdirSync(otherDir);

    const t1 = '2026-09-30T10:00:00.000Z';
    const t2 = '2026-09-30T11:00:00.000Z';
    const t3 = '2026-09-30T12:00:00.000Z';

    writeSession(sourceDir, 'a.jsonl', '/source', t1);
    writeSession(sourceDir, 'b.jsonl', '/source', t2);
    writeSession(otherDir, 'c.jsonl', '/other', t3);

    const folders = await loadSessionFolders(root);
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders[0]!.cwd, '/other');
    assert.strictEqual(folders[0]!.sessions.length, 1);
    assert.strictEqual(folders[0]!.sessions[0]!.id, 'c.jsonl');

    assert.strictEqual(folders[1]!.cwd, '/source');
    // Most recently modified first.
    assert.deepStrictEqual(
      folders[1]!.sessions.map((s) => s.id),
      ['b.jsonl', 'a.jsonl'],
    );
  });
});

test('loadSessionFolders picks up sessions stored directly in the root', async () => {
  await withTempDir('sv-sessions-', async (root) => {
    writeSession(root, 'root-session.jsonl', '', '2026-09-30T09:00:00.000Z');
    const folders = await loadSessionFolders(root);
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0]!.cwd, '<no cwd>');
    assert.strictEqual(folders[0]!.sessions[0]!.id, 'root-session.jsonl');
  });
});

test('loadSessionFolders ignores non-session files and empty subdirectories', async () => {
  await withTempDir('sv-sessions-', async (root) => {
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'notes.txt'), 'not a session');
    writeFileSync(join(root, 'empty', 'stray.jsonl'), '{bad json\n');
    const folders = await loadSessionFolders(root);
    assert.strictEqual(folders.length, 0);
  });
});

test('loadSessionFolders returns [] for a missing root', async () => {
  assert.deepStrictEqual(await loadSessionFolders('/nonexistent-sessions-root'), []);
});
