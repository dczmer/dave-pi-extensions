import type { ConfigResult } from "./config.ts";
import { saveConfig } from "./config.ts";
import { normalizePath, classifyPath } from "./guards.ts";
import { matchesAnyGlob } from "./matcher.ts";
import { isExternalApproved, approveExternal } from "./session.ts";
import { promptAllowDeny, confirmAddToConfigWithTarget, promptPattern } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

/**
 * Determine whether a file-access tool call should be allowed.
 *
 * Project paths are checked against `projectDeny` patterns; external paths
 * must match an `externalAllow` pattern or receive explicit user approval.
 * When the user approves an external path they are also prompted to persist a
 * glob pattern to the project or global config.
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
  const config = configResult.merged;
  const normalized = normalizePath(filePath, cwd);
  const normalizedCwd = normalizePath(cwd, cwd);
  const classification = classifyPath(normalized, cwd);

  if (classification === "project") {
    const relativePath = normalized === normalizedCwd
      ? "."
      : normalized.slice(normalizedCwd.length + 1);
    if (matchesAnyGlob(relativePath, config.projectDeny)) {
      ctx.ui.notify(`Blocked: ${filePath} matches projectDeny pattern`, "warning");
      return false;
    }
    return true;
  } else {
    if (isExternalApproved(normalized)) return true;
    if (matchesAnyGlob(normalized, config.externalAllow)) return true;

    const allowed = await promptAllowDeny(
      `Allow access to external file: ${filePath}?`,
      ctx,
    );
    if (!allowed) return false;

    approveExternal(normalized);

    const pattern = await promptPattern(
      filePath,
      "External path pattern",
      ctx,
    );
    if (pattern) {
      const addResult = await confirmAddToConfigWithTarget("externalAllow", ctx, pattern);
      if (addResult.confirmed) {
        if (addResult.target === "project") {
          configResult.project.externalAllow.push(pattern);
          saveConfig(configResult.project, configResult.projectPath);
        } else {
          configResult.global.externalAllow.push(pattern);
          saveConfig(configResult.global, configResult.globalPath);
        }
        // Update merged config to include the new pattern
        configResult.merged.externalAllow.push(pattern);
      }
    }
    return true;
  }
}
