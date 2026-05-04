import type { PiGateConfig } from "./config.ts";
import { saveConfig } from "./config.ts";
import { getSessionState, approveBashPattern } from "./session.ts";
import { matchesGlob } from "./matcher.ts";
import { extractPathsFromCommand } from "./guards.ts";
import { checkFileAccess } from "./file-access.ts";
import { promptAllowDeny, promptPattern, confirmAddToConfig } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

/** Extract commands from $(...) substitution. Handles nesting. */
function extractCommandSubstitutions(command: string): string[] {
  const results: string[] = [];
  let i = 0;

  while (i < command.length) {
    const start = command.indexOf("$(", i);
    if (start === -1) break;

    let depth = 1;
    let j = start + 2;
    while (j < command.length && depth > 0) {
      if (command[j] === "(" && command[j - 1] === "$") {
        depth++;
      } else if (command[j] === ")") {
        depth--;
      }
      j++;
    }

    if (depth === 0) {
      const inner = command.slice(start + 2, j - 1);
      results.push(inner);
      // Recursively extract nested substitutions
      results.push(...extractCommandSubstitutions(inner));
    }
    i = j;
  }

  return results;
}

/** Split compound command by &&, ||, ; and return individual statements. */
function splitCompoundCommand(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];

    // Skip whitespace
    if (char === " " || char === "\t") {
      if (current.length > 0) current += char;
      i++;
      continue;
    }

    // Handle command substitution - skip content inside $()
    if (char === "$" && nextChar === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(" && command[j - 1] === "$") {
          depth++;
        } else if (command[j] === ")") {
          depth--;
        }
        j++;
      }
      current += command.slice(i, j);
      i = j;
      continue;
    }

    // Handle string literals (single quotes)
    if (char === "'") {
      let j = i + 1;
      while (j < command.length && command[j] !== "'") {
        j++;
      }
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Handle string literals (double quotes)
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        // Skip escaped quotes
        if (command[j] === "\\") {
          j += 2;
        } else {
          j++;
        }
      }
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Check for separators: &&, ||, ;
    if ((char === "&" && nextChar === "&") || (char === "|" && nextChar === "|")) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      i += 2;
      continue;
    }

    if (char === ";") {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

/** Parse command into individual statements including command substitutions. */
export function parseCommandStatements(command: string): string[] {
  const statements = splitCompoundCommand(command);
  const allStatements: string[] = [];

  for (const stmt of statements) {
    allStatements.push(stmt);
    // Also extract command substitutions as separate statements to check
    const substitutions = extractCommandSubstitutions(stmt);
    allStatements.push(...substitutions);
  }

  return allStatements;
}

async function checkSingleCommand(
  command: string,
  cwd: string,
  config: PiGateConfig,
  ctx: ExtensionContext,
  configPath?: string,
): Promise<boolean> {
  const sessionState = getSessionState();
  const allPatterns = [...config.bashAllow, ...sessionState.approvedBashPatterns];
  const matchedPattern = allPatterns.find((p) => matchesGlob(command, p));

  if (!matchedPattern) {
    const allowed = await promptAllowDeny(`Allow bash command: ${command}?`, ctx);
    if (!allowed) return false;

    const pattern = await promptPattern(command, "Command pattern", ctx);
    if (!pattern) return false;

    approveBashPattern(pattern);

    if (await confirmAddToConfig("bashAllow", ctx, pattern)) {
      config.bashAllow.push(pattern);
      saveConfig(config, configPath);
    }

    // Re-check with updated patterns
    return checkSingleCommand(command, cwd, config, ctx, configPath);
  }

  // Check file arguments for this statement
  const paths = extractPathsFromCommand(command);
  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd, config, ctx, configPath);
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
  config: PiGateConfig,
  ctx: ExtensionContext,
  configPath?: string,
): Promise<boolean> {
  const statements = parseCommandStatements(command);

  for (const stmt of statements) {
    const allowed = await checkSingleCommand(stmt, cwd, config, ctx, configPath);
    if (!allowed) return false;
  }

  return true;
}
