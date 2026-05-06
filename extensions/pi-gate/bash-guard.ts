import bashParse from "bash-parser";
import type { ConfigResult } from "./config.ts";
import { saveConfig } from "./config.ts";
import { getSessionState, approveBashPattern } from "./session.ts";
import { matchesGlob } from "./matcher.ts";
import { extractPathsFromCommand } from "./guards.ts";
import { checkFileAccess } from "./file-access.ts";
import { promptAllowDeny, promptPattern, confirmAddToConfigWithTarget } from "./prompts.ts";
import type { ExtensionContext } from "./prompts.ts";

// ---------------------------------------------------------------------------
// AST types for bash-parser (subset we depend on)
// ---------------------------------------------------------------------------

interface Loc {
  start: { col: number; row: number; char: number };
  end: { col: number; row: number; char: number };
}

interface AstWord {
  type: "Word";
  text: string;
  expansion?: AstExpansion[];
  loc?: Loc;
}

interface AstCommandExpansion {
  type: "CommandExpansion";
  command: string;
  commandAST: AstScript;
  loc?: Loc;
}

type AstExpansion = AstCommandExpansion | { type: string; [key: string]: unknown };

interface AstCommand {
  type: "Command";
  name?: AstWord;
  suffix?: (AstWord | { type: string; [key: string]: unknown })[];
  loc?: Loc;
}

interface AstLogicalExpression {
  type: "LogicalExpression";
  op: "and" | "or";
  left: AstNode;
  right: AstNode;
}

interface AstPipeline {
  type: "Pipeline";
  commands: AstNode[];
}

interface AstCompoundList {
  type: "CompoundList";
  commands: AstNode[];
}

interface AstFor {
  type: "For";
  do: AstCompoundList;
}

interface AstWhile {
  type: "While" | "Until";
  do: AstCompoundList;
}

interface AstIf {
  type: "If";
  then: AstCompoundList;
  else?: AstCompoundList;
}

interface AstScript {
  type: "Script";
  commands: AstNode[];
  loc?: Loc;
}

type AstNode =
  | AstCommand
  | AstLogicalExpression
  | AstPipeline
  | AstCompoundList
  | AstFor
  | AstWhile
  | AstIf
  | AstScript
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/**
 * Extract the original command text from source using AST loc info.
 * Falls back to reconstructing from name/suffix Words.
 */
function commandTextFromSource(source: string, node: AstCommand): string | null {
  if (node.loc) {
    const { start, end } = node.loc;
    // loc.end.char is inclusive (index of last character)
    return source.slice(start.char, end.char + 1);
  }
  // Fallback: reconstruct from Word texts (quotes already stripped)
  const parts: string[] = [];
  if (node.name) parts.push(node.name.text);
  if (node.suffix) {
    for (const s of node.suffix) {
      if (s.type === "Word") parts.push((s as AstWord).text);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Recursively extract command texts from CommandExpansion nodes.
 * Each CommandExpansion carries a `command` (raw text) and an optional
 * `commandAST` we recurse into for nested sub-commands.
 */
function extractCommandSubsFromNode(source: string, node: AstNode): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  function walk(n: AstNode): void {
    if (n.type === "Command" && (n as AstCommand).suffix) {
      for (const s of (n as AstCommand).suffix!) {
        if (s.type !== "Word") continue;
        const w = s as AstWord;
        if (!w.expansion) continue;
        for (const exp of w.expansion) {
          if (exp.type !== "CommandExpansion") continue;
          const ce = exp as AstCommandExpansion;
          if (!seen.has(ce.command)) {
            seen.add(ce.command);
            results.push(ce.command);
          }
          // Recurse into the substitution's own AST
          walkCommands(ce.commandAST);
        }
      }
    }
    walkCommands(n);
  }

  function walkCommands(n: AstNode): void {
    const cmdList =
      (n.type === "Script" || n.type === "CompoundList") ? (n as AstScript | AstCompoundList).commands
      : n.type === "Pipeline" ? (n as AstPipeline).commands
      : null;

    if (cmdList) {
      for (const cmd of cmdList) walk(cmd);
      return;
    }

    if (n.type === "LogicalExpression") {
      const le = n as AstLogicalExpression;
      walk(le.left);
      walk(le.right);
      return;
    }

    if (n.type === "For" || n.type === "While" || n.type === "Until") {
      walkCommands((n as AstFor | AstWhile).do);
      return;
    }

    if (n.type === "If") {
      const ifNode = n as AstIf;
      walkCommands(ifNode.then);
      if (ifNode.else) walkCommands(ifNode.else);
      return;
    }
  }

  walk(node);
  return results;
}

/**
 * Walk bash-parser AST (already decorated with loc info via `insertLOC: true`)
 * and return every leaf-command text (original source slice) plus any
 * command-substitution texts.  Order: parent command first, then its
 * nested substitutions.
 */
function walkAstForStatements(source: string, node: AstNode): string[] {
  const statements: string[] = [];

  function walk(n: AstNode): void {
    if (n.type === "Script" || n.type === "CompoundList") {
      for (const cmd of (n as AstScript | AstCompoundList).commands) {
        walk(cmd);
      }
      return;
    }

    if (n.type === "Command") {
      const text = commandTextFromSource(source, n as AstCommand);
      if (text) statements.push(text);
      statements.push(...extractCommandSubsFromNode(source, n));
      return;
    }

    if (n.type === "LogicalExpression") {
      const le = n as AstLogicalExpression;
      walk(le.left);
      walk(le.right);
      return;
    }

    if (n.type === "Pipeline") {
      for (const cmd of (n as AstPipeline).commands) {
        walk(cmd);
      }
      return;
    }

    if (n.type === "For" || n.type === "While" || n.type === "Until") {
      walk((n as AstFor | AstWhile).do);
      return;
    }

    if (n.type === "If") {
      const ifNode = n as AstIf;
      walk(ifNode.then);
      if (ifNode.else) walk(ifNode.else);
      return;
    }
  }

  walk(node);
  return statements;
}

// ---------------------------------------------------------------------------
// Manual fallback parser
// ---------------------------------------------------------------------------

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
      results.push(...extractCommandSubstitutions(inner));
    }
    i = j;
  }

  return results;
}

/** Split compound command by &&, ||, ; while respecting quoting, heredocs, $(). */
function splitCompoundCommand(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (char === " " || char === "\t") {
      if (current.length > 0) current += char;
      i++;
      continue;
    }

    // $()
    if (char === "$" && nextChar === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(" && command[j - 1] === "$") depth++;
        else if (command[j] === ")") depth--;
        j++;
      }
      current += command.slice(i, j);
      i = j;
      continue;
    }

    // Single quotes
    if (char === "'") {
      let j = i + 1;
      while (j < command.length && command[j] !== "'") j++;
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Double quotes
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\") j += 2;
        else j++;
      }
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Heredoc <<[-]DELIMITER
    if (char === "<" && nextChar === "<") {
      let j = i + 2;
      let stripTabs = false;
      if (j < command.length && command[j] === "-") {
        stripTabs = true;
        j++;
      }
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;

      let delimiter = "";
      if (j < command.length && command[j] === "'") {
        j++;
        while (j < command.length && command[j] !== "'") delimiter += command[j++];
        if (j < command.length) j++;
      } else if (j < command.length && command[j] === '"') {
        j++;
        while (j < command.length && command[j] !== '"') {
          if (command[j] === "\\") { delimiter += command[j + 1] || ""; j += 2; }
          else delimiter += command[j++];
        }
        if (j < command.length) j++;
      } else {
        while (j < command.length && !/\s/.test(command[j])) delimiter += command[j++];
      }

      current += command.slice(i, j);
      i = j;

      // Scan for delimiter at line start
      const linesStart = i;
      while (i < command.length) {
        const atLineStart = i === 0 || command[i - 1] === "\n";
        if (atLineStart) {
          let k = i;
          if (stripTabs) while (k < command.length && command[k] === "\t") k++;
          if (command.slice(k, k + delimiter.length) === delimiter) {
            const after = k + delimiter.length;
            if (after >= command.length || /\s/.test(command[after])) {
              current += command.slice(linesStart, after);
              i = after;
              break;
            }
          }
        }
        i++;
      }
      continue;
    }

    // Separators: &&, ||
    if ((char === "&" && nextChar === "&") || (char === "|" && nextChar === "|")) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    // Separator: ;
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Manual fallback: split and extract substitutions. */
function parseCommandStatementsManual(command: string): string[] {
  const statements = splitCompoundCommand(command);
  const all: string[] = [];

  for (const stmt of statements) {
    all.push(stmt);
    all.push(...extractCommandSubstitutions(stmt));
  }

  return all;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Constructs bash-parser cannot handle — use fallback. */
function needsManualFallback(command: string): boolean {
  // Heredocs cause parse errors or mis-parses across both posix and bash modes
  return command.includes("<<");
}

/** Parse command into individual statements including command substitutions. */
export function parseCommandStatements(command: string): string[] {
  if (needsManualFallback(command)) {
    return parseCommandStatementsManual(command);
  }
  try {
    const ast = bashParse(command, { insertLOC: true });
    return walkAstForStatements(command, ast);
  } catch {
    // Fallback for deeply nested $() and other edge cases
    return parseCommandStatementsManual(command);
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

  for (const stmt of statements) {
    const allowed = await checkSingleCommand(stmt, cwd, configResult, ctx);
    if (!allowed) return false;
  }

  return true;
}
