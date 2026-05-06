import { parseBashCommand, collectStatements } from "../../src/bash-parser.ts";
import type { ConfigResult } from "./config.ts";
import { saveConfig } from "./config.ts";
import { getSessionState, approveBashPattern } from "./session.ts";
import { matchesGlob } from "./matcher.ts";
import { extractPathsFromCommand } from "./guards.ts";
import { checkFileAccess } from "./file-access.ts";
import { promptAllowDeny, promptPattern, confirmAddToConfigWithTarget } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** Parse command into individual statements. Returns null on parse failure. */
export function parseCommandStatements(command: string): string[] | null {
  // Heredocs cause bash-parser to misparse (posix mode) or produce
  // garbage ASTs (bash mode).  Bail out.
  if (command.includes("<<")) return null;
  try {
    const ast = parseBashCommand(command);
    return collectStatements(command, ast);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command checking
// ---------------------------------------------------------------------------

async function checkSingleCommand(
  command: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
): Promise<boolean> {
  const config = configResult.merged;
  const sessionState = getSessionState();
  const allPatterns = [...config.bashAllow, ...sessionState.approvedBashPatterns];
  const hasMatch = allPatterns.some((p) => matchesGlob(command, p));

  if (!hasMatch) {
    const allowed = await promptAllowDeny(`Allow bash command: ${command}?`, ctx);
    if (!allowed) return false;

    const pattern = await promptPattern(command, "Command pattern", ctx);
    if (!pattern) return false;

    approveBashPattern(pattern);

    const addResult = await confirmAddToConfigWithTarget("bashAllow", ctx, pattern);
    if (addResult.confirmed) {
      if (addResult.target === "project") {
        configResult.project.bashAllow.push(pattern);
        saveConfig(configResult.project, configResult.projectPath);
      } else {
        configResult.global.bashAllow.push(pattern);
        saveConfig(configResult.global, configResult.globalPath);
      }
      configResult.merged.bashAllow.push(pattern);
    }

    return checkSingleCommand(command, cwd, configResult, ctx);
  }

  // Check file arguments for this statement
  const paths = extractPathsFromCommand(command);
  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd, configResult, ctx);
    if (!allowed) {
      ctx.ui.notify(`Blocked: file ${filePath} in command denied`, "warning");
      return false;
    }
  }

  return true;
}

export async function checkBashCommand(
  command: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
): Promise<boolean> {
  const statements = parseCommandStatements(command);
  if (statements === null) {
    ctx.ui.notify("Blocked: failed to parse command", "warning");
    return false;
  }

  for (const stmt of statements) {
    const allowed = await checkSingleCommand(stmt, cwd, configResult, ctx);
    if (!allowed) return false;
  }

  return true;
}
