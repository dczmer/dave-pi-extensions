import { strictEqual } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fragmentsPath, loadFragments, parseFragments } from '../../../extensions/prompt-fragments/fragments.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

test('missing file yields empty result without warnings', () => {
  withTempDir('prompt-fragments-', (dir) => {
    const result = loadFragments(dir);
    strictEqual(result.fragments.length, 0);
    strictEqual(result.warnings.length, 0);
  });
});

test('valid array loads all fragments', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(
      fragmentsPath(dir),
      JSON.stringify([
        { name: 'tdd', prompt: 'Write a failing test first.' },
        { name: 'careful', prompt: 'Read all relevant files.' },
      ]),
    );
    const result = loadFragments(dir);
    strictEqual(result.warnings.length, 0);
    strictEqual(result.fragments.length, 2);
    strictEqual(result.fragments[0]?.name, 'tdd');
    strictEqual(result.fragments[1]?.name, 'careful');
  });
});

test('malformed JSON yields warning and empty result', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(join(dir, 'prompt-fragments.json'), '{ not json');
    const result = loadFragments(dir);
    strictEqual(result.fragments.length, 0);
    strictEqual(result.warnings.length, 1);
  });
});

test('malformed and duplicate entries are skipped with a count warning', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(
      fragmentsPath(dir),
      JSON.stringify([
        { name: 'ok', prompt: 'fine' },
        { name: 'dup', prompt: 'first' },
        { name: 'dup', prompt: 'second' },
        { name: '', prompt: 'empty name' },
        { name: 'no-prompt' },
        { prompt: 'no name' },
        'a string entry',
        42,
      ]),
    );
    const result = loadFragments(dir);
    strictEqual(result.fragments.length, 2);
    strictEqual(result.fragments[0]?.name, 'ok');
    strictEqual(result.fragments[1]?.name, 'dup');
    strictEqual(result.fragments[1]?.prompt, 'first');
    strictEqual(result.warnings.length, 1);
    strictEqual(result.warnings[0], '6 malformed/duplicate fragment(s) skipped');
  });
});

test('parseFragments rejects non-array top-level values', () => {
  for (const raw of [null, {}, 'nope', 42]) {
    const result = parseFragments(raw);
    strictEqual(result.fragments.length, 0);
    strictEqual(result.warnings[0], 'top-level value is not an array');
  }
});

test('entries with blank-only name or prompt are rejected', () => {
  const result = parseFragments([
    { name: '  ', prompt: 'x' },
    { name: 'x', prompt: ' \n ' },
  ]);
  strictEqual(result.fragments.length, 0);
  strictEqual(result.warnings[0], '2 malformed/duplicate fragment(s) skipped');
});
