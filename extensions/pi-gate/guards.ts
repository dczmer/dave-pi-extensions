/**
 * Expand `~`, resolve relative paths against `cwd`, and normalize.
 * Removes `.` segments, resolves `..` segments, and collapses multiple
 * consecutive slashes.
 *
 * @param filePath - Raw path from user input or tool call.
 * @param cwd - Current working directory for relative resolution.
 * @returns A clean absolute path with no redundant segments.
 */
import { homedir } from 'node:os';

export function normalizePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('~')) {
    const home = homedir() || '/';
    filePath = home + filePath.slice(1);
  }

  if (!filePath.startsWith('/')) {
    filePath = cwd + '/' + filePath;
  }

  const parts = filePath.split('/');
  const result: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return '/' + result.join('/');
}

/**
 * Determine whether a path belongs to the project tree or lies outside it.
 *
 * @param filePath - Already-normalized absolute path.
 * @param cwd - Normalized project root.
 * @returns `"project"` if the path is under `cwd`, `"external"` otherwise.
 */
export function classifyPath(filePath: string, cwd: string): 'project' | 'external' {
  const normalized = normalizePath(filePath, cwd);
  const normalizedCwd = normalizePath(cwd, cwd);

  if (normalized === normalizedCwd) return 'project';
  if (normalized.startsWith(normalizedCwd + '/')) return 'project';
  return 'external';
}

function consumeWhile(
  command: string,
  start: number,
  predicate: (ch: string) => boolean
): { token: string; newI: number } {
  let j = start;
  while (j < command.length && predicate(command[j]!)) {
    j++;
  }
  return { token: command.slice(start, j), newI: j };
}

function extractSingleQuote(command: string, start: number): { token: string; newI: number } {
  let j = start + 1;
  while (j < command.length && command[j] !== "'") {
    j++;
  }
  return { token: command.slice(start, j + 1), newI: j + 1 };
}

function extractQuoteWithEscapes(
  command: string,
  start: number,
  contentStart: number,
  closeChar: string
): { token: string; newI: number } {
  let j = contentStart;
  while (j < command.length && command[j] !== closeChar) {
    if (command[j] === '\\') {
      j += 2;
    } else {
      j++;
    }
  }
  return { token: command.slice(start, j + 1), newI: j + 1 };
}

function skipBalancedParens(
  command: string,
  start: number,
  isOpen: (cmd: string, index: number) => boolean
): number {
  let depth = 1;
  let j = start;
  while (j < command.length && depth > 0) {
    if (isOpen(command, j)) {
      depth++;
    } else if (command[j] === ')') {
      depth--;
    }
    j++;
  }
  return j;
}

function skipBacktick(command: string, start: number): number {
  let j = start + 1;
  while (j < command.length && command[j] !== '`') {
    if (command[j] === '\\') {
      j += 2;
    } else {
      j++;
    }
  }
  return j + 1;
}

function skipHeredoc(command: string, start: number): { token: string; newI: number } {
  let j = start + 2;
  if (j < command.length && command[j] === '-') {
    j++;
  }
  while (j < command.length && /\s/.test(command[j]!) && command[j]! !== '\n') {
    j++;
  }
  let delimiter = '';
  if (j < command.length && command[j] === "'") {
    j++;
    while (j < command.length && command[j] !== "'") {
      delimiter += command[j];
      j++;
    }
    if (j < command.length) j++;
  } else if (j < command.length && command[j] === '"') {
    j++;
    while (j < command.length && command[j] !== '"') {
      if (command[j] === '\\') {
        delimiter += command[j + 1] || '';
        j += 2;
      } else {
        delimiter += command[j];
        j++;
      }
    }
    if (j < command.length) j++;
  } else {
    while (j < command.length && !/\s/.test(command[j]!)) {
      delimiter += command[j]!;
      j++;
    }
  }
  const token = command.slice(start, j);
  let i = j;
  while (i < command.length) {
    const atLineStart = i === 0 || command[i - 1] === '\n';
    if (atLineStart) {
      let k = i;
      while (k < command.length && command[k] === '\t') {
        k++;
      }
      if (command.slice(k, k + delimiter.length) === delimiter) {
        const afterDelimiter = k + delimiter.length;
        if (afterDelimiter >= command.length || /\s/.test(command[afterDelimiter] || '')) {
          i = afterDelimiter;
          break;
        }
      }
    }
    i++;
  }
  return { token, newI: i };
}

/**
 * Tokenize a bash command string and extract positional arguments that look
 * like file paths.  Respects quoting (single, double, ANSI-C), skips heredocs,
 * command/process substitution bodies, redirection operators, and shell control
 * operators.
 *
 * @param command - Raw bash command string.
 * @returns Array of tokens that may represent file-system paths.
 */
export function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  const tokens: string[] = [];
  let i = 0;

  while (i < command.length) {
    const char = command[i]!;
    const next = command[i + 1];

    switch (true) {
      case /\s/.test(char):
        i++;
        break;
      case char === "'": {
        const { token, newI } = extractSingleQuote(command, i);
        tokens.push(token);
        i = newI;
        break;
      }
      case char === '"': {
        const { token, newI } = extractQuoteWithEscapes(command, i, i + 1, '"');
        tokens.push(token);
        i = newI;
        break;
      }
      case char === '$' && next === "'": {
        const { token, newI } = extractQuoteWithEscapes(command, i, i + 2, "'");
        tokens.push(token);
        i = newI;
        break;
      }
      case char === '$' && next === '(':
        i = skipBalancedParens(command, i + 2, (cmd, idx) => cmd[idx] === '(' && cmd[idx - 1] === '$');
        break;
      case char === '`':
        i = skipBacktick(command, i);
        break;
      case char === '<' && next === '<': {
        const { token, newI } = skipHeredoc(command, i);
        tokens.push(token);
        i = newI;
        break;
      }
      case (char === '<' || char === '>') && next === '(':
        i = skipBalancedParens(command, i + 2, (cmd, idx) => cmd[idx] === '(');
        break;
      case /[<>]/.test(char): {
        const { token, newI } = consumeWhile(command, i, (ch) => /[<>0-9]/.test(ch));
        tokens.push(token);
        i = newI;
        break;
      }
      default: {
        const { token, newI } = consumeWhile(command, i, (ch) => !/\s/.test(ch));
        tokens.push(token);
        i = newI;
        break;
      }
    }
  }

  if (tokens.length === 0) return [];

  const args = tokens.slice(1);
  const operators = new Set(['|', '||', '&', '&&', ';', '(', ')', '{', '}', '>', '>>', '<', '<<', '<<-']);

  for (const token of args) {
    if (token.startsWith('-')) continue;
    if (operators.has(token)) continue;
    if (token.startsWith("'") || token.startsWith('"') || token.startsWith("$'")) continue;
    if (token.startsWith('$(') || token.startsWith('`') || token.startsWith('<(') || token.startsWith('>(')) continue;
    paths.push(token);
  }

  return paths;
}
