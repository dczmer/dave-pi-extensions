import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  generateSlugFromText,
  isPathWithinCwd,
  isPlanArtifactPath,
  isTempPath,
  isUnderArtifactDir,
  isValidPlanFilePath,
  resolvePlanFilePath,
} from '../../../extensions/plan-mode/plan-artifact.ts';
import { withTempDir } from '../../../test/utils/temp-dir.ts';

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

// ── Plan path helpers ─────────────────────────────────────────

test('resolvePlanFilePath resolves relative path against cwd', () => {
  strictEqual(resolvePlanFilePath('plans/foo.md', '/project'), '/project/plans/foo.md');
});

test('resolvePlanFilePath normalises absolute path', () => {
  strictEqual(resolvePlanFilePath('/project/plans/../foo.md', '/project'), '/project/foo.md');
});

test('isPathWithinCwd accepts child path', () => {
  strictEqual(isPathWithinCwd('plans/foo.md', '/project'), true);
});

test('isPathWithinCwd rejects path outside cwd', () => {
  strictEqual(isPathWithinCwd('/other/foo.md', '/project'), false);
});

test('isPathWithinCwd rejects traversal escape', () => {
  strictEqual(isPathWithinCwd('/project/../other/foo.md', '/project'), false);
});

test('isValidPlanFilePath: accepts existing file', () => {
  withTempDir('pi-plan-', (dir) => {
    const file = join(dir, 'plans', 'foo.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Plan');
    const result = isValidPlanFilePath(file, dir);
    strictEqual(result.ok, true);
  });
});

test('isValidPlanFilePath: accepts non-existing file in existing directory', () => {
  withTempDir('pi-plan-', (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const result = isValidPlanFilePath(join(dir, 'plans', 'foo.md'), dir);
    strictEqual(result.ok, true);
  });
});

test('isValidPlanFilePath: rejects path outside cwd', () => {
  withTempDir('pi-plan-', (dir) => {
    const result = isValidPlanFilePath('/other/foo.md', dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('must be inside project'));
  });
});

test('isValidPlanFilePath: rejects directory', () => {
  withTempDir('pi-plan-', (dir) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const result = isValidPlanFilePath(join(dir, 'plans'), dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('is a directory'));
  });
});

test('isValidPlanFilePath: rejects missing parent directory', () => {
  withTempDir('pi-plan-', (dir) => {
    const result = isValidPlanFilePath(join(dir, 'missing', 'foo.md'), dir);
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('parent directory does not exist'));
  });
});

test('isValidPlanFilePath: rejects EACCES permission error on target', () => {
  withTempDir('pi-plan-', (dir) => {
    const file = join(dir, 'plans', 'foo.md');
    mkdirSync(dirname(file), { recursive: true });
    chmodSync(dirname(file), 0o000);
    try {
      const result = isValidPlanFilePath(file, dir);
      strictEqual(result.ok, false);
      ok((result as { reason: string }).reason.includes('Permission denied'));
    } finally {
      chmodSync(dirname(file), 0o755);
    }
  });
});

test('isValidPlanFilePath: rejects unexpected statSync errors without throwing', () => {
  withTempDir('pi-plan-', (dir) => {
    const file = join(dir, 'plans', 'foo.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Plan');

    const result = isValidPlanFilePath(file, dir, {
      statSync: () => {
        const err = new Error('Too many symbolic links') as NodeJS.ErrnoException;
        err.code = 'ELOOP';
        throw err;
      },
    });
    strictEqual(result.ok, false);
    ok((result as { reason: string }).reason.includes('Cannot validate plan file path'));
    ok((result as { reason: string }).reason.includes('ELOOP'));
  });
});
