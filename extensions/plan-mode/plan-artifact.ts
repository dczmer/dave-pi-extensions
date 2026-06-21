import { resolve, normalize, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';

/**
 * Strip one pair of surrounding quotes from a path argument.
 *
 * @param rawPath - Path that may be wrapped in quotes.
 * @returns Path with surrounding quotes removed.
 */
export function stripQuotes(rawPath: string): string {
  if (rawPath.length >= 2) {
    const first = rawPath[0];
    const last = rawPath[rawPath.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return rawPath.slice(1, -1);
    }
  }
  return rawPath;
}

/**
 * Sanitize a path captured from natural-language input.
 *
 * Strips trailing prose after conjunctions/prepositions, removes quotes,
 * and rejects strings that do not look like file paths.
 *
 * @param rawPath - Path segment captured from user input.
 * @returns Cleaned path if it looks valid, otherwise undefined.
 */
export function sanitizeExtractedPlanPath(rawPath: string): string | undefined {
  const unquoted = stripQuotes(rawPath);
  const wasQuoted = unquoted !== rawPath;

  let cleaned = unquoted.trim();
  if (!cleaned) return undefined;

  if (!wasQuoted) {
    // Strip trailing prose (e.g., "plans/foo.md and implement it").
    cleaned = cleaned.replace(
      /\s+(?:and|then|to|with|for|from|of|in|on|at|under|over|but|because|so|if|when)\b.*$/i,
      '',
    );
  }

  // Must look like a file path: contains a separator or has a file extension.
  if (!cleaned.includes('/') && !/\.[a-zA-Z0-9]+$/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

const ARTIFACT_DIR = '.pi/artifacts';
const PLAN_PATTERN = /^plan-[a-zA-Z0-9_-]+\.md$/;

/**
 * Resolve a possibly-relative plan file path against cwd and normalise it.
 *
 * @param filePath - Relative or absolute path.
 * @param cwd - Current working directory.
 * @returns Normalised absolute path.
 */
export function resolvePlanFilePath(filePath: string, cwd: string): string {
  return normalize(resolve(cwd, filePath));
}

/**
 * Determine whether a file path stays inside cwd.
 *
 * Uses resolve + normalise; symlinks are not considered.
 *
 * @param filePath - Absolute or relative path.
 * @param cwd - Current working directory.
 * @returns `true` if the resolved path is within cwd.
 */
export function isPathWithinCwd(filePath: string, cwd: string): boolean {
  const absolute = resolvePlanFilePath(filePath, cwd);
  const normCwd = normalize(resolve(cwd)) + '/';
  const normPath = absolute + '/';
  return absolute === normalize(resolve(cwd)) || normPath.startsWith(normCwd);
}

/**
 * Validate that a plan file path is usable.
 *
 * Checks:
 * - path resolves inside cwd
 * - if it exists, it is not a directory
 * - if it does not exist, its parent directory exists
 * - permission errors are surfaced instead of treated as "does not exist"
 *
 * @param filePath - Relative or absolute path to validate.
 * @param cwd - Current working directory.
 * @returns Ok result, or an error reason.
 */
export function isValidPlanFilePath(
  filePath: string,
  cwd: string,
  deps: { statSync?: typeof fs.statSync } = {},
): { ok: true } | { ok: false; reason: string } {
  const stat = deps.statSync ?? fs.statSync;
  const resolved = resolvePlanFilePath(filePath, cwd);

  if (!isPathWithinCwd(resolved, cwd)) {
    return { ok: false, reason: `Plan file path must be inside project directory: ${filePath}` };
  }

  let stats;
  try {
    stats = stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, reason: `Permission denied reading plan file path: ${filePath}` };
    }

    if (code === 'ENOENT') {
      const parent = dirname(resolved);
      try {
        const parentStats = stat(parent);
        if (!parentStats.isDirectory()) {
          return { ok: false, reason: `Plan file parent is not a directory: ${parent}` };
        }
      } catch (parentErr) {
        const parentCode = (parentErr as NodeJS.ErrnoException).code;
        if (parentCode === 'ENOENT') {
          return { ok: false, reason: `Plan file parent directory does not exist: ${parent}` };
        }
        if (parentCode === 'EACCES' || parentCode === 'EPERM') {
          return {
            ok: false,
            reason: `Permission denied reading plan file parent directory: ${parent}`,
          };
        }
        return {
          ok: false,
          reason: `Cannot validate plan file path: ${filePath} (${parentCode || (parentErr as Error).message})`,
        };
      }
      return { ok: true };
    }

    return {
      ok: false,
      reason: `Cannot validate plan file path: ${filePath} (${code || (err as Error).message})`,
    };
  }

  if (stats.isDirectory()) {
    return { ok: false, reason: `Plan file path is a directory: ${filePath}` };
  }

  return { ok: true };
}

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
