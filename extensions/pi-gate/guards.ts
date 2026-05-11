/**
 * Expand `~`, resolve relative paths against cwd, and normalize.
 * Removes `.`, handles `..`, and collapses multiple slashes.
 */
import { homedir } from "node:os";

export function normalizePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~")) {
    const home = homedir() || "/";
    filePath = home + filePath.slice(1);
  }

  if (!filePath.startsWith("/")) {
    filePath = cwd + "/" + filePath;
  }

  const parts = filePath.split("/");
  const result: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/** Classify a path as inside the project (`cwd`) or external. */
export function classifyPath(
  filePath: string,
  cwd: string,
): "project" | "external" {
  const normalized = normalizePath(filePath, cwd);
  const normalizedCwd = normalizePath(cwd, cwd);

  if (normalized === normalizedCwd) return "project";
  if (normalized.startsWith(normalizedCwd + "/")) return "project";
  return "external";
}

/** Bash-aware tokenizer: extracts potential file-path args, respecting quotes. */
export function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  const tokens: string[] = [];
  let i = 0;

  // First pass: tokenize respecting quotes and substitutions
  while (i < command.length) {
    const char = command[i]!;

    // Skip leading whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Handle single-quoted strings (no escapes)
    if (char === "'") {
      let j = i + 1;
      while (j < command.length && command[j] !== "'") {
        j++;
      }
      tokens.push(command.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Handle double-quoted strings (with escapes)
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\") {
          j += 2;
        } else {
          j++;
        }
      }
      tokens.push(command.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Handle ANSI-C quoted strings $'...'
    if (char === "$" && command[i + 1] === "'") {
      let j = i + 2;
      while (j < command.length && command[j] !== "'") {
        if (command[j] === "\\") {
          j += 2;
        } else {
          j++;
        }
      }
      tokens.push(command.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Handle command substitution $()
    if (char === "$" && command[i + 1] === "(") {
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
      // Skip command substitution entirely - paths inside are not direct args
      i = j;
      continue;
    }

    // Handle backtick command substitution ``
    if (char === "`") {
      let j = i + 1;
      while (j < command.length && command[j] !== "`") {
        if (command[j] === "\\") {
          j += 2;
        } else {
          j++;
        }
      }
      // Skip backtick substitution entirely
      i = j + 1;
      continue;
    }

    // Handle heredocs - skip them entirely
    if (char === "<" && command[i + 1] === "<") {
      let j = i + 2;
      if (j < command.length && command[j] === "-") {
        j++;
      }
      while (j < command.length && /\s/.test(command[j]!) && command[j]! !== "\n") {
        j++;
      }
      // Parse delimiter
      let delimiter = "";
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
          if (command[j] === "\\") {
            delimiter += command[j + 1] || "";
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
      // Include heredoc operator token
      tokens.push(command.slice(i, j));
      i = j;
      // Skip heredoc body
      while (i < command.length) {
        const atLineStart = i === 0 || command[i - 1] === "\n";
        if (atLineStart) {
          let k = i;
          while (k < command.length && command[k] === "\t") {
            k++;
          }
          if (command.slice(k, k + delimiter.length) === delimiter) {
            const afterDelimiter = k + delimiter.length;
            if (afterDelimiter >= command.length || /\s/.test(command[afterDelimiter] || "")) {
              i = afterDelimiter;
              break;
            }
          }
        }
        i++;
      }
      continue;
    }

    // Handle process substitution <() >()
    if ((char === "<" || char === ">") && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") {
          depth++;
        } else if (command[j] === ")") {
          depth--;
        }
        j++;
      }
      // Skip process substitution
      i = j;
      continue;
    }

    // Handle redirections
    if (/[<>]/.test(char)) {
      let j = i;
      while (j < command.length && /[<>0-9]/.test(command[j]!)) {
        j++;
      }
      tokens.push(command.slice(i, j));
      i = j;
      continue;
    }

    // Handle unquoted word
    let j = i;
    while (j < command.length && !/\s/.test(command[j]!)) {
      j++;
    }
    tokens.push(command.slice(i, j));
    i = j;
  }

  if (tokens.length === 0) return [];

  const args = tokens.slice(1);
  const operators = new Set([
    "|",
    "||",
    "&",
    "&&",
    ";",
    "(",
    ")",
    "{",
    "}",
    ">",
    ">>",
    "<",
    "<<",
    "<<-",
  ]);

  for (const token of args) {
    // Skip options
    if (token.startsWith("-")) continue;
    // Skip operators
    if (operators.has(token)) continue;
    // Skip quoted strings (these are literals, not paths to check)
    if (token.startsWith("'") || token.startsWith('"') || token.startsWith("$'")) continue;
    // Skip command substitutions and process substitutions
    if (token.startsWith("$(") || token.startsWith("`") || token.startsWith("<(") || token.startsWith(">(")) continue;
    // This might be a path
    paths.push(token);
  }

  return paths;
}
