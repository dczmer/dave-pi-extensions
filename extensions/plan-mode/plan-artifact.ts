import { resolve, normalize, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
 * Generate a unique plan file basename using today's date and a random fragment.
 *
 * @returns A slug like `plan-20260512-a1b2c3d4`.
 */
export function generatePlanSlug(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomUUID().slice(0, 8);
  return `plan-${date}-${rand}`;
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
