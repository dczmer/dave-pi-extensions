import { parseBashCommand, collectStatements, extractPathsFromAST, commandText } from '../../src/bash-parser.ts';
import type {
  AstNode,
  AstScript,
  AstCommand,
  AstWord,
  AstCommandExpansion,
  AstLogicalExpression,
  AstPipeline,
  AstFor,
  AstIf,
} from '../../src/bash-parser.ts';
import type { ConfigResult } from './config.ts';
import { saveConfig } from './config.ts';
import { getApprovedBashPatterns, approveBashPattern, isBashEnabled } from './session.ts';
import { matchesGlob } from './matcher.ts';
import { extractPathsFromCommand } from './guards.ts';
import { checkFileAccess } from './file-access.ts';
import { promptPattern, confirmAddToConfigWithTarget } from './prompts.ts';
import type { ExtensionContext } from './prompts.ts';
import { judgeBashCommand } from './judge.ts';
import type { Completer, JudgeOutcome, JudgeVerdictDetails } from './judge.ts';

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Parse a bash command into individual logical statements.
 *
 * @param command - Raw bash command string.
 * @returns Array of statement text strings, or `null` if parsing failed
 *          (including when heredocs are present, which are not supported).
 */
export function parseCommandStatements(command: string): string[] | null {
  if (command.includes('<<')) return null;
  try {
    const ast = parseBashCommand(command);
    return collectStatements(command, ast);
  } catch {
    return null;
  }
}

/** A statement with its AST node for richer inspection (path extraction). */
interface StatementEntry {
  text: string;
  cmd: AstCommand | null; // null for raw subshell text
}

/** Like parseCommandStatements but retains AST nodes for each statement. */
function parseStatementEntries(command: string): StatementEntry[] | null {
  if (command.includes('<<')) return null;

  let ast: AstScript;
  try {
    ast = parseBashCommand(command);
  } catch {
    return null;
  }

  const entries: StatementEntry[] = [];
  const seenSubs = new Set<string>();

  function walk(node: AstNode): void {
    if (node.type === 'Script' || node.type === 'CompoundList') {
      for (const c of (node as AstScript).commands) walk(c);
      return;
    }

    if (node.type === 'Command') {
      const cmd = node as AstCommand;
      const text = commandText(command, cmd);
      if (text) entries.push({ text, cmd });

      // Emit raw subshell texts
      if (cmd.suffix) {
        for (const s of cmd.suffix) {
          if (s.type !== 'Word') continue;
          const w = s as AstWord;
          if (!w.expansion) continue;
          for (const exp of w.expansion) {
            if (exp.type !== 'CommandExpansion') continue;
            const ce = exp as AstCommandExpansion;
            if (!seenSubs.has(ce.command)) {
              seenSubs.add(ce.command);
              entries.push({ text: ce.command, cmd: null });
            }
          }
        }
      }
      return;
    }

    if (node.type === 'LogicalExpression') {
      const le = node as AstLogicalExpression;
      walk(le.left);
      walk(le.right);
      return;
    }

    if (node.type === 'Pipeline') {
      for (const c of (node as AstPipeline).commands) walk(c);
      return;
    }

    if (node.type === 'For' || node.type === 'While' || node.type === 'Until') {
      walk((node as AstFor).do);
      return;
    }

    if (node.type === 'If') {
      const ifn = node as AstIf;
      walk(ifn.then);
      if (ifn.else) walk(ifn.else);
      return;
    }

    if (node.type === 'Subshell') {
      walk((node as unknown as { list: AstNode }).list);
      return;
    }

    if (node.type === 'Function') {
      walk((node as unknown as { body: AstNode }).body);
      return;
    }
  }

  walk(ast);
  return entries;
}

// ---------------------------------------------------------------------------
// Command checking
// ---------------------------------------------------------------------------

/** Transcript-logging hooks for judge outcomes. */
export interface BashGuardHooks {
  /** Called with each judge outcome that has a transcript message. */
  onJudgeOutcome?(outcome: JudgeOutcome, details?: JudgeVerdictDetails, error?: string): void;
}

/** Optional dependencies for {@link checkBashCommand}. */
export interface BashGuardOptions {
  /** Injected judge completer (tests). */
  complete?: Completer;
  /** Called with each judge outcome that has a transcript message. */
  hooks?: BashGuardHooks;
}

async function checkSingleCommand(
  command: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
  cmdNode?: AstCommand,
): Promise<boolean> {
  const config = configResult.merged;
  const allPatterns = [...config.bashAllow, ...getApprovedBashPatterns()];
  // When the bash guard is toggled off, treat every command as matched; file
  // paths inside the command are still checked by the external-path guard.
  const hasMatch = !isBashEnabled() || allPatterns.some((p) => matchesGlob(command, p));

  if (!hasMatch) {
    const pattern = await promptPattern(command, 'Allow command pattern (Esc to reject)', ctx);
    if (!pattern) return false;

    approveBashPattern(pattern);

    const addResult = await confirmAddToConfigWithTarget('bashAllow', ctx, pattern);
    if (addResult.confirmed) {
      if (addResult.target === 'project') {
        configResult.project.bashAllow.push(pattern);
        saveConfig(configResult.project, configResult.projectPath);
      } else {
        configResult.global.bashAllow.push(pattern);
        saveConfig(configResult.global, configResult.globalPath);
      }
      configResult.merged.bashAllow.push(pattern);
    }

    return checkSingleCommand(command, cwd, configResult, ctx, cmdNode);
  }

  // Extract file paths: prefer AST when available, fall back to string tokenizer
  const paths = cmdNode ? extractPathsFromAST(cmdNode) : extractPathsFromCommand(command);

  for (const filePath of paths) {
    const allowed = await checkFileAccess(filePath, cwd, configResult, ctx);
    if (!allowed) {
      ctx.ui.notify(`Blocked: file ${filePath} in command denied`, 'warning');
      return false;
    }
  }

  return true;
}

/**
 * Check whether a bash tool call should be allowed.
 *
 * Splits the command into individual statements, matches each against
 * configured and session bash-allow globs, prompts the user for new commands,
 * and recursively checks any file paths referenced by the command against the
 * file-access policy.
 *
 * @param command - Raw bash command string.
 * @param cwd - Project working directory.
 * @param configResult - Loaded & merged pi-gate config.
 * @param ctx - Pi extension context providing UI and persistence helpers.
 * @param options - Optional injected judge completer and logging hooks.
 * @returns `true` if all statements and their file references are allowed.
 */
export async function checkBashCommand(
  command: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
  options: BashGuardOptions = {},
): Promise<boolean> {
  const entries = parseStatementEntries(command);
  if (entries === null) {
    const result = await judgeBashCommand(command, cwd, configResult, ctx, {
      ...(options.complete ? { complete: options.complete } : {}),
    });
    if (result.outcome) options.hooks?.onJudgeOutcome?.(result.outcome, result.details, result.error);
    if (result.decision === 'allow') return true;
    if (result.decision === 'deny') return false;

    ctx.ui.notify('Command not parsable — manual approval required', 'warning');
    return ctx.ui.confirm('pi-gate: unparsable command', 'Could not parse command. Allow anyway?\n\n' + command);
  }

  for (const entry of entries) {
    const allowed = await checkSingleCommand(entry.text, cwd, configResult, ctx, entry.cmd ?? undefined);
    if (!allowed) return false;
  }

  return true;
}
