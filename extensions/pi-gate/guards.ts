/**
 * Expand `~`, resolve relative paths against cwd, and normalize.
 * Removes `.`, handles `..`, and collapses multiple slashes.
 */
export function normalizePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("~")) {
    const home = Deno.env.get("HOME") || "/";
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

/** Naive tokenizer: splits command and returns potential file-path args. */
export function extractPathsFromCommand(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
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
  ]);

  return args.filter((t) => !t.startsWith("-") && !operators.has(t));
}
