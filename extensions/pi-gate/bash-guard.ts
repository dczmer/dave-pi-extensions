import type { PiGateConfig } from "./config.ts";
import { saveConfig } from "./config.ts";
import { getSessionState, approveBashPattern } from "./session.ts";
import { matchesGlob } from "./matcher.ts";
import { extractPathsFromCommand } from "./guards.ts";
import { checkFileAccess } from "./file-access.ts";
import { promptAllowDeny, promptPattern, confirmAddToConfig } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

export async function checkBashCommand(
  command: string,
  cwd: string,
  config: PiGateConfig,
  ctx: ExtensionContext,
): Promise<boolean> {
  // Step 1: Check command pattern
  const sessionState = getSessionState();
  const allPatterns = [...config.bashAllow, ...sessionState.approvedBashPatterns];
  const matchedPattern = allPatterns.find((p) => matchesGlob(command, p));

  if (!matchedPattern) {
    const allowed = await promptAllowDeny(`Allow bash command: ${command}?`, ctx);
    if (!allowed) return false;

    const pattern = await promptPattern(command, "Command pattern", ctx);
    if (!pattern) return false;

    approveBashPattern(pattern);

    if (await confirmAddToConfig("bashAllow", ctx)) {
      config.bashAllow.push(pattern);
      saveConfig(cwd, config);
    }

    // Re-check with updated patterns
    return checkBashCommand(command, cwd, config, ctx);
  }

  // Step 2: Extract and check file arguments
  const paths = extractPathsFromCommand(command);
  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd, config, ctx);
    if (!allowed) {
      ctx.ui.notify(`Blocked: file ${filePath} in command denied`, "warning");
      return false;
    }
  }

  return true;
}
