import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import {
  generateSlugFromText,
  isPlanArtifactPath,
  isTempPath,
  isUnderArtifactDir,
} from '../../../extensions/plan-mode/plan-artifact.ts';

test('generateSlugFromText produces dated slug from text', () => {
  const slug = generateSlugFromText('Implement user authentication with OAuth2');
  ok(/^plan-\d{8}-implement-user-authentication-with-oauth2$/.test(slug));
});

test('generateSlugFromText limits words', () => {
  const slug = generateSlugFromText('One two three four five six seven eight');
  ok(slug.endsWith('-one-two-three-four-five-six'));
});

test('generateSlugFromText sanitizes punctuation', () => {
  const slug = generateSlugFromText('Refactor API (v2) caching!!!');
  strictEqual(slug.endsWith('-refactor-api-v2-caching'), true);
});

test('generateSlugFromText falls back to plan when text is empty', () => {
  const slug = generateSlugFromText('');
  ok(/^plan-\d{8}-plan$/.test(slug));
});

test('generateSlugFromText handles only special characters', () => {
  const slug = generateSlugFromText('!!!@@@###');
  ok(/^plan-\d{8}-plan$/.test(slug));
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
