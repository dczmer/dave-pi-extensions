import type { PiGateConfig } from "./config.ts";
import { saveConfig } from "./config.ts";
import { normalizePath, classifyPath } from "./guards.ts";
import { matchesAnyGlob } from "./matcher.ts";
import { isExternalApproved, approveExternal } from "./session.ts";
import { promptAllowDeny, confirmAddToConfig, promptPattern } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

export async function checkFileAccess(
  filePath: string,
  cwd: string,
  config: PiGateConfig,
  ctx: ExtensionContext,
  configPath?: string,
): Promise<boolean> {
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
    if (pattern && await confirmAddToConfig("externalAllow", ctx, pattern)) {
      config.externalAllow.push(pattern);
      saveConfig(config, configPath);
    }
    return true;
  }
}
