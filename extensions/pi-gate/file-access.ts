import type { ConfigResult } from './config.ts';
import { saveConfig, normalizeExternalEntry } from './config.ts';
import { normalizePath, classifyPath } from './guards.ts';
import { matchesAnyWhitelistEntry } from './matcher.ts';
import { isExternalApproved, approveExternalPattern, isExternalEnabled } from './session.ts';
import { confirmAddToConfigWithTarget, promptPattern } from './prompts.ts';
import type { ExtensionContext } from './prompts.ts';

/**
 * Determine whether a file-access tool call should be allowed.
 *
 * Project paths are allowed by default; external paths must match an
 * `externalAllow` pattern or receive explicit user approval.
 * When the user approves an external path they are also prompted to persist a
 * glob pattern to the project or global config. The editor is pre-filled with
 * the normalized absolute path (never the raw tool input, which may use `~`)
 * and the session whitelist stores that normalized pattern (not just the
 * concrete path), so choosing not to persist still approves every path the
 * pattern covers for the session.
 *
 * @param filePath - Raw path from the tool call input.
 * @param cwd - Project working directory.
 * @param configResult - Loaded & merged pi-gate config.
 * @param ctx - Pi extension context providing UI and persistence helpers.
 * @returns `true` if access should be permitted, `false` to block the call.
 */
export async function checkFileAccess(
  filePath: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
): Promise<boolean> {
  // Session toggle: external-path guard disabled entirely.
  if (!isExternalEnabled()) return true;

  const config = configResult.merged;
  const normalized = normalizePath(filePath, cwd);
  const classification = classifyPath(normalized, cwd);

  if (classification === 'project') {
    return true;
  }

  // Session whitelist: exact / directory-prefix / glob
  if (isExternalApproved(normalized)) return true;

  // Config patterns: same three rules as session
  if (matchesAnyWhitelistEntry(normalized, config.externalAllow)) return true;

  // Pre-fill with the normalized path: the raw tool input may be a
  // `~`-prefixed or relative string that would be persisted verbatim and then
  // never match a normalized probe path.
  const pattern = await promptPattern(normalized, 'Allow external path pattern (Esc to reject)', ctx);
  if (!pattern) return false;

  // Store the normalized *pattern*, not the concrete path, so the session
  // whitelist covers every path the pattern matches.
  const normalizedPattern = normalizeExternalEntry(pattern, cwd);
  approveExternalPattern(normalizedPattern);

  const addResult = await confirmAddToConfigWithTarget('externalAllow', ctx, normalizedPattern);
  if (addResult.confirmed) {
    if (addResult.target === 'project') {
      configResult.project.externalAllow.push(normalizedPattern);
      saveConfig(configResult.project, configResult.projectPath);
    } else {
      configResult.global.externalAllow.push(normalizedPattern);
      saveConfig(configResult.global, configResult.globalPath);
    }
    // Update merged config to include the new pattern
    configResult.merged.externalAllow.push(normalizedPattern);
  }
  return true;
}
