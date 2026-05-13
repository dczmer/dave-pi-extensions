import { strictEqual, ok, notStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import {
  generatePlanSlug,
  isPlanArtifactPath,
  isTempPath,
  isUnderArtifactDir,
  extractTopicSlug,
} from '../../../extensions/plan-mode/plan-artifact.ts';

test('generatePlanSlug produces unique values', () => {
  const a = generatePlanSlug();
  const b = generatePlanSlug();
  notStrictEqual(a, b);
  ok(/^plan-[a-zA-Z0-9_-]+$/.test(a));
  ok(/^plan-[a-zA-Z0-9_-]+$/.test(b));
});

test('isPlanArtifactPath: accepts plan artifact with slug', () => {
  strictEqual(isPlanArtifactPath('.pi/artifacts/plan-20260512-abc123.md', '/project'), true);
});

test('isPlanArtifactPath: rejects bare plan.md', () => {
  strictEqual(isPlanArtifactPath('.pi/artifacts/plan.md', '/project'), false);
});

test('isPlanArtifactPath: rejects non-plan files', () => {
  strictEqual(isPlanArtifactPath('.pi/artifacts/notes.md', '/project'), false);
});

test('isPlanArtifactPath: rejects path outside artifacts dir', () => {
  strictEqual(isPlanArtifactPath('.pi/plan-20260512-abc123.md', '/project'), false);
  strictEqual(isPlanArtifactPath('plan-20260512-abc123.md', '/project'), false);
});

test('isPlanArtifactPath: blocks directory traversal', () => {
  strictEqual(isPlanArtifactPath('.pi/artifacts/../../etc/passwd', '/project'), false);
});

test('isPlanArtifactPath: accepts absolute path', () => {
  strictEqual(isPlanArtifactPath('/project/.pi/artifacts/plan-20260512-abc123.md', '/project'), true);
});

test('isTempPath: allows /tmp files', () => {
  strictEqual(isTempPath('/tmp/foo.txt'), true);
  strictEqual(isTempPath('/tmp/sub/dir/file'), true);
});

test('isTempPath: allows system temp directory', () => {
  strictEqual(isTempPath(tmpdir() + '/foo.txt'), true);
});

test('isTempPath: blocks traversal escaping /tmp', () => {
  strictEqual(isTempPath('/tmp/../etc/passwd'), false);
});

test('isTempPath: rejects relative tmp paths', () => {
  strictEqual(isTempPath('tmp/foo.txt'), false);
});

test('isTempPath: rejects non-temp absolute paths', () => {
  strictEqual(isTempPath('/etc/passwd'), false);
  strictEqual(isTempPath('/var/tmp/foo.txt'), false);
});

test('isUnderArtifactDir: accepts artifact dir itself', () => {
  strictEqual(isUnderArtifactDir('.pi/artifacts', '/project'), true);
});

test('isUnderArtifactDir: accepts artifact subdirectory', () => {
  strictEqual(isUnderArtifactDir('.pi/artifacts/subdir', '/project'), true);
});

test('isUnderArtifactDir: rejects sibling of artifacts', () => {
  strictEqual(isUnderArtifactDir('.pi/plan.md', '/project'), false);
});

test('isUnderArtifactDir: rejects unrelated path', () => {
  strictEqual(isUnderArtifactDir('other/dir', '/project'), false);
});

test('isUnderArtifactDir: blocks directory traversal', () => {
  strictEqual(isUnderArtifactDir('.pi/artifacts/../../etc', '/project'), false);
});

test('extractTopicSlug: generates slug from first line', () => {
  strictEqual(
    extractTopicSlug('Refactor authentication middleware for better security'),
    'refactor-authentication-middleware-for-better-security',
  );
});

test('extractTopicSlug: limits to 6 words by default', () => {
  strictEqual(extractTopicSlug('One two three four five six seven eight'), 'one-two-three-four-five-six');
});

test('extractTopicSlug: respects custom maxWords', () => {
  strictEqual(extractTopicSlug('One two three four five six seven', 4), 'one-two-three-four');
});

test('extractTopicSlug: lowercases and sanitizes punctuation', () => {
  strictEqual(extractTopicSlug('Implement user-auth (with OAuth2!)'), 'implement-user-auth-with-oauth2');
});

test('extractTopicSlug: trims leading and trailing non-alphanumeric', () => {
  strictEqual(extractTopicSlug('!!!Hello World!!!'), 'hello-world');
});

test('extractTopicSlug: caps length to maxLength', () => {
  const long = 'a'.repeat(100);
  strictEqual(extractTopicSlug(long, 6, 10).length, 10);
});

test('extractTopicSlug: skips empty lines to find first non-empty', () => {
  strictEqual(extractTopicSlug('\n\n  Hello World  \n\nMore text'), 'hello-world');
});

test('extractTopicSlug: returns empty string when content is empty', () => {
  strictEqual(extractTopicSlug(''), '');
  strictEqual(extractTopicSlug('\n\n   \n'), '');
});
