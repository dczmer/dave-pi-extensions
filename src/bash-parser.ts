import bashParse from "bash-parser";

// ---------------------------------------------------------------------------
// AST types (shared by pi-gate and plan-mode)
// ---------------------------------------------------------------------------

export interface Loc {
  start: { col: number; row: number; char: number };
  end: { col: number; row: number; char: number };
}

export interface AstWord {
  type: "Word";
  text: string;
  expansion?: AstExpansion[];
  loc?: Loc;
}

export interface AstRedirect {
  type: "Redirect";
  op: { type: string; text: string };
  file: AstWord;
  loc?: Loc;
}

export interface AstCommandExpansion {
  type: "CommandExpansion";
  command: string;
  commandAST: AstScript;
  loc?: Loc;
}

export type AstExpansion =
  | AstCommandExpansion
  | { type: string; [key: string]: unknown };

export interface AstCommand {
  type: "Command";
  name?: AstWord;
  suffix?: (AstWord | AstRedirect | { type: string; [key: string]: unknown })[];
  loc?: Loc;
}

export interface AstLogicalExpression {
  type: "LogicalExpression";
  op: "and" | "or";
  left: AstNode;
  right: AstNode;
}

export interface AstPipeline {
  type: "Pipeline";
  commands: AstNode[];
}

export interface AstCompoundList {
  type: "CompoundList";
  commands: AstNode[];
}

export interface AstFor {
  type: "For";
  do: AstCompoundList;
}

export interface AstWhile {
  type: "While" | "Until";
  do: AstCompoundList;
}

export interface AstIf {
  type: "If";
  then: AstCompoundList;
  else?: AstCompoundList;
}

export interface AstScript {
  type: "Script";
  commands: AstNode[];
  loc?: Loc;
}

export type AstNode =
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
// Parser
// ---------------------------------------------------------------------------

/** Parse a bash command string into an AST with location info. Throws on parse failure. */
export function parseBashCommand(source: string): AstScript {
  return bashParse(source, { insertLOC: true }) as AstScript;
}

// ---------------------------------------------------------------------------
// Source text helpers
// ---------------------------------------------------------------------------

/**
 * Extract the original command text from source via loc offsets.
 * loc.end.char is inclusive (index of last character).
 */
export function textFromLoc(source: string, loc: Loc): string {
  return source.slice(loc.start.char, loc.end.char + 1);
}

/** Reconstruct command text from AST (loc preferred, falls back to name+suffix). */
export function commandText(source: string, cmd: AstCommand): string | null {
  if (cmd.loc) return textFromLoc(source, cmd.loc);
  const parts: string[] = [];
  if (cmd.name) parts.push(cmd.name.text);
  if (cmd.suffix) {
    for (const s of cmd.suffix) {
      if (s.type === "Word") parts.push((s as AstWord).text);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// AST walker — visits every leaf Command in the tree
// ---------------------------------------------------------------------------

export type CommandVisitor = (cmd: AstCommand, sourceText: string | null) => void;

/**
 * Walk all leaf Command nodes (into loops, pipelines, conditionals,
 * AND command substitutions).  For each, calls `visitor(cmd, sourceText)`.
 *
 * @param source - Original command string for loc-based text extraction.
 *   Pass `""` if source text isn't needed.
 */
export function walkCommands(
  ast: AstScript,
  visitor: CommandVisitor,
  source = "",
): void {
  walkNode(ast, visitor, source);
}

function walkNode(
  node: AstNode,
  visitor: CommandVisitor,
  source: string,
): void {
  if (node.type === "Script" || node.type === "CompoundList") {
    for (const cmd of (node as AstScript | AstCompoundList).commands) {
      walkNode(cmd, visitor, source);
    }
    return;
  }

  if (node.type === "Command") {
    const cmd = node as AstCommand;
    visitor(cmd, commandText(source, cmd));

    // Recurse into command substitutions found in suffix Words
    if (cmd.suffix) {
      for (const s of cmd.suffix) {
        if (s.type !== "Word") continue;
        const w = s as AstWord;
        if (!w.expansion) continue;
        for (const exp of w.expansion) {
          if (exp.type === "CommandExpansion") {
            const ce = exp as AstCommandExpansion;
            walkNode(ce.commandAST, visitor, source);
          }
        }
      }
    }
    return;
  }

  if (node.type === "LogicalExpression") {
    const le = node as AstLogicalExpression;
    walkNode(le.left, visitor, source);
    walkNode(le.right, visitor, source);
    return;
  }

  if (node.type === "Pipeline") {
    for (const cmd of (node as AstPipeline).commands) {
      walkNode(cmd, visitor, source);
    }
    return;
  }

  if (node.type === "For" || node.type === "While" || node.type === "Until") {
    walkNode((node as AstFor | AstWhile).do, visitor, source);
    return;
  }

  if (node.type === "If") {
    const ifNode = node as AstIf;
    walkNode(ifNode.then, visitor, source);
    if (ifNode.else) walkNode(ifNode.else, visitor, source);
    return;
  }

  if (node.type === "Subshell") {
    const sub = node as unknown as { list: AstCompoundList };
    walkNode(sub.list, visitor, source);
    return;
  }

  if (node.type === "Function") {
    const fn = node as unknown as { body: AstCompoundList };
    walkNode(fn.body, visitor, source);
    return;
  }
}

// ---------------------------------------------------------------------------
// Statement collector — for pi-gate's parseCommandStatements
// ---------------------------------------------------------------------------

/**
 * Walk the AST and collect command-text statements for pattern matching.
 *
 * Differs from `walkCommands`: emits the *raw* text of command substitutions
 * (from CommandExpansion.command) instead of recursing into their internal
 * Command nodes.  This matches pi-gate's legacy behavior where `$(date)` in
 * `echo $(date)` yields the statements `["echo $(date)", "date"]`.
 */
export function collectStatements(source: string, ast: AstScript): string[] {
  const statements: string[] = [];
  const seenSubs = new Set<string>();

  function collect(node: AstNode): void {
    if (node.type === "Script" || node.type === "CompoundList") {
      for (const cmd of (node as AstScript | AstCompoundList).commands) {
        collect(cmd);
      }
      return;
    }

    if (node.type === "Command") {
      const cmd = node as AstCommand;
      const text = commandText(source, cmd);
      if (text) statements.push(text);

      // Emit raw subshell texts from CommandExpansion nodes
      if (cmd.suffix) {
        for (const s of cmd.suffix) {
          if (s.type !== "Word") continue;
          const w = s as AstWord;
          if (!w.expansion) continue;
          for (const exp of w.expansion) {
            if (exp.type !== "CommandExpansion") continue;
            const ce = exp as AstCommandExpansion;
            if (!seenSubs.has(ce.command)) {
              seenSubs.add(ce.command);
              statements.push(ce.command);
            }
          }
        }
      }
      return;
    }

    if (node.type === "LogicalExpression") {
      const le = node as AstLogicalExpression;
      collect(le.left);
      collect(le.right);
      return;
    }

    if (node.type === "Pipeline") {
      for (const cmd of (node as AstPipeline).commands) {
        collect(cmd);
      }
      return;
    }

    if (node.type === "For" || node.type === "While" || node.type === "Until") {
      collect((node as AstFor | AstWhile).do);
      return;
    }

    if (node.type === "If") {
      const ifNode = node as AstIf;
      collect(ifNode.then);
      if (ifNode.else) collect(ifNode.else);
      return;
    }

    if (node.type === "Subshell") {
      collect((node as unknown as { list: AstCompoundList }).list);
      return;
    }

    if (node.type === "Function") {
      collect((node as unknown as { body: AstCompoundList }).body);
      return;
    }
  }

  collect(ast);
  return statements;
}

// ---------------------------------------------------------------------------
// Path extraction from AST
// ---------------------------------------------------------------------------

/**
 * Extract potential file-path arguments from a Command node's suffix.
 * Skips options (-flag), redirects, operators, and variable references.
 * Replaces manual re-tokenization of command strings.
 */
export function extractPathsFromAST(cmd: AstCommand): string[] {
  const paths: string[] = [];
  if (!cmd.suffix) return paths;

  for (const item of cmd.suffix) {
    // Redirects have their own file field, not a command argument
    if (item.type === "Redirect") continue;
    if (item.type !== "Word") continue;

    const w = item as AstWord;
    const t = w.text;

    // Options/flags
    if (t.startsWith("-")) continue;
    // Variable references ($VAR, ${VAR})
    if (t.startsWith("$")) continue;
    // Tilde expansion (~/path) — the text from bash-parser is already expanded
    // to /home/user/path? Actually no, bash-parser leaves it as "~/path".
    // Let normalizePath handle it.

    paths.push(t);
  }

  return paths;
}
