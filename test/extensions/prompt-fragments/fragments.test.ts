import { strictEqual } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fragmentsPath, loadFragments, parseFragments } from '../../../extensions/prompt-fragments/fragments.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

test('missing file yields empty lists without warnings', () => {
  withTempDir('prompt-fragments-', (dir) => {
    const result = loadFragments(dir);
    strictEqual(result.fragments.prepend.length, 0);
    strictEqual(result.fragments.append.length, 0);
    strictEqual(result.warnings.length, 0);
  });
});

test('prepend and append lists load independently', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(
      fragmentsPath(dir),
      JSON.stringify({
        prepend: [{ name: 'tdd', prompt: 'Write a failing test first.' }],
        append: [
          { name: 'careful', prompt: 'Read all relevant files.' },
          { name: 'concise', prompt: 'Be brief.' },
        ],
      }),
    );
    const result = loadFragments(dir);
    strictEqual(result.warnings.length, 0);
    strictEqual(result.fragments.prepend.length, 1);
    strictEqual(result.fragments.prepend[0]?.name, 'tdd');
    strictEqual(result.fragments.append.length, 2);
    strictEqual(result.fragments.append[0]?.name, 'careful');
    strictEqual(result.fragments.append[1]?.name, 'concise');
  });
});

test('missing list keys default to empty arrays', () => {
  const result = parseFragments({ prepend: [{ name: 'a', prompt: 'A' }] });
  strictEqual(result.fragments.prepend.length, 1);
  strictEqual(result.fragments.append.length, 0);
});

test('malformed JSON yields warning and empty lists', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(join(dir, 'prompt-fragments.json'), '{ not json');
    const result = loadFragments(dir);
    strictEqual(result.fragments.prepend.length, 0);
    strictEqual(result.fragments.append.length, 0);
    strictEqual(result.warnings.length, 1);
  });
});

test('malformed and duplicate entries are skipped with a per-list count warning', () => {
  withTempDir('prompt-fragments-', (dir) => {
    writeFileSync(
      fragmentsPath(dir),
      JSON.stringify({
        prepend: [
          { name: 'ok', prompt: 'fine' },
          { name: 'dup', prompt: 'first' },
          { name: 'dup', prompt: 'second' },
          { name: '', prompt: 'empty name' },
          { name: 'no-prompt' },
          { prompt: 'no name' },
          'a string entry',
          42,
        ],
        append: [
          { name: 'only', prompt: 'fine' },
          { name: 'only', prompt: 'repeat' },
        ],
      }),
    );
    const result = loadFragments(dir);
    strictEqual(result.fragments.prepend.length, 2);
    strictEqual(result.fragments.prepend[0]?.name, 'ok');
    strictEqual(result.fragments.prepend[1]?.name, 'dup');
    strictEqual(result.fragments.prepend[1]?.prompt, 'first');
    strictEqual(result.fragments.append.length, 1);
    strictEqual(result.fragments.append[0]?.name, 'only');
    strictEqual(result.warnings.length, 2);
    strictEqual(result.warnings[0], 'prepend: 6 malformed/duplicate fragment(s) skipped');
    strictEqual(result.warnings[1], 'append: 1 malformed/duplicate fragment(s) skipped');
  });
});

test('the same name may appear in both lists', () => {
  const result = parseFragments({
    prepend: [{ name: 'shared', prompt: 'before' }],
    append: [{ name: 'shared', prompt: 'after' }],
  });
  strictEqual(result.fragments.prepend.length, 1);
  strictEqual(result.fragments.append.length, 1);
  strictEqual(result.warnings.length, 0);
});

test('non-object top-level values are rejected', () => {
  for (const raw of [null, [], 'nope', 42]) {
    const result = parseFragments(raw);
    strictEqual(result.fragments.prepend.length, 0);
    strictEqual(result.fragments.append.length, 0);
    strictEqual(result.warnings[0], 'top-level value is not an object');
  }
});

test('non-array list values are rejected with a warning', () => {
  const result = parseFragments({ prepend: 'nope', append: {} });
  strictEqual(result.fragments.prepend.length, 0);
  strictEqual(result.fragments.append.length, 0);
  strictEqual(result.warnings[0], '"prepend" is not an array');
  strictEqual(result.warnings[1], '"append" is not an array');
});

test('entries with blank-only name or prompt are rejected', () => {
  const result = parseFragments({
    prepend: [
      { name: '  ', prompt: 'x' },
      { name: 'x', prompt: ' \n ' },
    ],
  });
  strictEqual(result.fragments.prepend.length, 0);
  strictEqual(result.warnings[0], 'prepend: 2 malformed/duplicate fragment(s) skipped');
});
