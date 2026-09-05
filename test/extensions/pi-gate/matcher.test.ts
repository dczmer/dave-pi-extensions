import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { matchesGlob, matchesAnyGlob, matchesAnyWhitelistEntry } from '../../../extensions/pi-gate/matcher.ts';

test('exact string match', () => {
  strictEqual(matchesGlob('ls', 'ls'), true);
});

test('single wildcard * matches any chars', () => {
  strictEqual(matchesGlob('anything', '*'), true);
});

test('wildcard at end only', () => {
  strictEqual(matchesGlob('cat foo.txt', 'cat *'), true);
});

test('wildcard in middle', () => {
  strictEqual(matchesGlob('file123.txt', 'file*.txt'), true);
  strictEqual(matchesGlob('file.txt', 'file*.txt'), true);
});

test('multiple wildcards', () => {
  strictEqual(matchesGlob('src/main.txt', '*/*.txt'), true);
  strictEqual(matchesGlob('a/b/c.txt', '*/*/*.txt'), true);
});

test('? single character match', () => {
  strictEqual(matchesGlob('abc', 'a?c'), true);
});

test('? rejects zero chars', () => {
  strictEqual(matchesGlob('ac', 'a?c'), false);
});

test('? rejects multiple chars', () => {
  strictEqual(matchesGlob('abbc', 'a?c'), false);
});

test('matchesAnyGlob first match', () => {
  strictEqual(matchesAnyGlob('ls', ['ls', 'cat']), true);
});

test('matchesAnyGlob second match', () => {
  strictEqual(matchesAnyGlob('cat', ['ls', 'cat']), true);
});

test('matchesAnyGlob no match', () => {
  strictEqual(matchesAnyGlob('rm', ['ls', 'cat']), false);
});

test('empty pattern returns false', () => {
  strictEqual(matchesGlob('ls', ''), false);
});

test('empty value matches *', () => {
  strictEqual(matchesGlob('', '*'), true);
});

test('pattern equals value with literal * char', () => {
  strictEqual(matchesGlob('ls -la *', 'ls -la *'), true);
});

test('case sensitivity (Unix-style)', () => {
  strictEqual(matchesGlob('LS', 'ls'), false);
  strictEqual(matchesGlob('ls', 'LS'), false);
});

test('special regex chars treated as literal', () => {
  strictEqual(matchesGlob('a.b', 'a.b'), true);
  strictEqual(matchesGlob('a+b', 'a+b'), true);
  strictEqual(matchesGlob('a(b)', 'a(b)'), true);
});

test('pattern longer than value returns false', () => {
  strictEqual(matchesGlob('ls', 'ls -l'), false);
});

test('value longer than pattern returns false', () => {
  strictEqual(matchesGlob('ls -l', 'ls'), false);
});

test('whitelist: exact entry match', () => {
  strictEqual(matchesAnyWhitelistEntry('/tmp/a.txt', ['/tmp/a.txt']), true);
  strictEqual(matchesAnyWhitelistEntry('/tmp/a.txtx', ['/tmp/a.txt']), false);
});

test('whitelist: directory prefix approves descendants', () => {
  strictEqual(matchesAnyWhitelistEntry('/tmp/allowed-dir/sub/file.txt', ['/tmp/allowed-dir']), true);
  strictEqual(matchesAnyWhitelistEntry('/tmp/allowed-dir', ['/tmp/allowed-dir']), true);
});

test('whitelist: directory prefix rejects siblings', () => {
  strictEqual(matchesAnyWhitelistEntry('/tmp/allowed-dir2/x.txt', ['/tmp/allowed-dir']), false);
  strictEqual(matchesAnyWhitelistEntry('/tmp/allowed', ['/tmp/allowed-dir']), false);
});

test('whitelist: glob entry with * crossing slashes', () => {
  strictEqual(matchesAnyWhitelistEntry('/nix/blahblah/foo', ['/nix/blahblah/*']), true);
  strictEqual(matchesAnyWhitelistEntry('/nix/blahblah/a/b/c', ['/nix/blahblah/*']), true);
  strictEqual(matchesAnyWhitelistEntry('/nix/blahblah', ['/nix/blahblah/*']), false);
});

test('whitelist: trailing slashes stripped from config entries', () => {
  strictEqual(matchesAnyWhitelistEntry('/nix/blahblah/file.txt', ['/nix/blahblah/']), true);
  strictEqual(matchesAnyWhitelistEntry('/nix/blahblah', ['/nix/blahblah/']), true);
});

test('whitelist: any matching entry allows', () => {
  strictEqual(matchesAnyWhitelistEntry('/b/match', ['/a/*', '/b/*', '/c/*']), true);
  strictEqual(matchesAnyWhitelistEntry('/z/match', ['/a/*', '/b/*', '/c/*']), false);
});
