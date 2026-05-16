import { resolve, normalize, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ARTIFACT_DIR = '.pi/artifacts';
const PLAN_PATTERN = /^plan-[a-zA-Z0-9_-]+\.md$/;

/**
 * Determine whether a file path resolves inside the plan artifact directory.
 *
 * @param filePath - Path from the tool call (absolute or relative).
 * @param cwd - Current working directory.
 * @returns `true` if the resolved path is under `{cwd}/.pi/artifacts/`.
 */
export function isUnderArtifactDir(filePath: string, cwd: string): boolean {
  const absolute = resolve(cwd, filePath);
  const artifactDir = normalize(resolve(cwd, ARTIFACT_DIR)) + '/';
  const normPath = normalize(absolute) + '/';
  return normPath.startsWith(artifactDir);
}

/**
 * Generate a plan slug from user input text.
 *
 * Sanitizes the text into a kebab-case slug and prefixes
 * it with today's date and `plan-`.
 *
 * @param text - User message or request text.
 * @returns A slug like `plan-20260512-implement-user-auth`.
 */
export function generateSlugFromText(text: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .join('-');
  const base = slug || 'plan';
  return `plan-${date}-${base}`;
}

/**
 * Determine whether a file path is a permitted plan artifact.
 *
 * Only files inside `{cwd}/.pi/artifacts/` whose basename matches
 * `plan-<slug>.md` are allowed.
 *
 * @param filePath - Path from the tool call (absolute or relative).
 * @param cwd - Current working directory.
 * @returns `true` if the path is a valid plan artifact.
 */
export function isPlanArtifactPath(filePath: string, cwd: string): boolean {
  const absolute = resolve(cwd, filePath);
  const artifactDir = normalize(resolve(cwd, ARTIFACT_DIR)) + '/';
  const normPath = normalize(absolute) + '/';
  if (!normPath.startsWith(artifactDir)) return false;
  return PLAN_PATTERN.test(basename(absolute));
}

/**
 * Determine whether a file path resolves inside a temporary directory.
 *
 * Allows `/tmp/...` and the OS-specific temporary directory.
 *
 * @param filePath - Path from the tool call (absolute or relative).
 * @returns `true` if the resolved path is under a temp directory.
 */
export function isTempPath(filePath: string): boolean {
  const absolute = resolve(filePath);
  const normPath = normalize(absolute) + '/';
  const systemTmp = normalize(tmpdir()) + '/';
  return normPath.startsWith('/tmp/') || normPath.startsWith(systemTmp);
}
