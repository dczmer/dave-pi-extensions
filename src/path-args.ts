/**
 * Command-aware filtering of positional arguments for path extraction.
 *
 * Generic path extraction treats every non-option word as a potential file
 * path, which misclassifies regex patterns and inline scripts as paths
 * (`grep '/pat/' file`, `sed '/pat/,+15p' file`, `awk '/pat/{ cmd }' file`).
 * This module encodes, per well-known tool, which arguments are patterns or
 * scripts rather than paths.
 */

/** Argument-consumption semantics for a tool whose arguments mix paths with patterns/scripts. */
interface ToolSpec {
  /** Exact-match options that consume the following word as a value (never a path). */
  valueOptions?: readonly string[];
  /**
   * Exact-match options whose consumed value is a pattern/script. Like
   * `valueOptions`, the next word is skipped; additionally the tool's
   * leading pattern slot is filled by the option, so later positional words
   * are all treated as paths.
   */
  patternOptions?: readonly string[];
  /** The first positional word is a pattern/script, not a path (unless a patternOption was seen). */
  firstPositionalIsPattern?: boolean;
  /** Combined short-flag clusters (e.g. `-pe`, `-wle`) containing any of these letters consume the next word as code. */
  codeFlagLetters?: string;
  /** Skip positional words starting with `+` (less/vim/ex startup commands such as `+/pat`). */
  skipPlusWords?: boolean;
  /** No positional word is ever a path (e.g. `tr` char sets). */
  noPositionalPaths?: boolean;
}

/** grep-family tools share the same "pattern then files" argument shape. */
const GREP_SPEC: ToolSpec = {
  patternOptions: ['-e', '-f'],
  valueOptions: [
    '-m',
    '-A',
    '-B',
    '-C',
    '-D',
    '-d',
    '--max-count',
    '--context',
    '--after-context',
    '--before-context',
    '--devices',
    '--directories',
    '--label',
    '--binary-files',
    '--regexp',
    '--file',
    '--include',
    '--exclude',
    '--exclude-dir',
  ],
  firstPositionalIsPattern: true,
};

const RG_SPEC: ToolSpec = {
  ...GREP_SPEC,
  valueOptions: [...(GREP_SPEC.valueOptions ?? []), '-g', '--glob', '--iglob', '--type-add', '--colors'],
};

const AWK_SPEC: ToolSpec = {
  patternOptions: ['-f', '--file'],
  valueOptions: ['-v', '-F', '-W', '--assign', '--field-separator', '--characters-as-bytes', '--lint'],
  firstPositionalIsPattern: true,
};

const SED_SPEC: ToolSpec = {
  // `-i` takes only an optional *attached* backup suffix (`-i.bak`), never a
  // separate word; there are no separate-word value options to skip.
  patternOptions: ['-e', '-f', '--expression', '--file'],
  firstPositionalIsPattern: true,
};

const JQ_SPEC: ToolSpec = {
  valueOptions: ['-f', '--from-file', '--arg', '--argjson', '--slurpfile', '--rawfile', '--argfile', '--args'],
  firstPositionalIsPattern: true,
};

/** perl/ruby: combined flags ending in `e` (or plain `-e`) take the program as the next word. */
const PERL_SPEC: ToolSpec = {
  valueOptions: ['-M', '-m', '-I'],
  codeFlagLetters: 'e',
};

const LESS_SPEC: ToolSpec = {
  valueOptions: ['-p', '--pattern', '--prompt'],
  skipPlusWords: true,
};

const VIM_SPEC: ToolSpec = {
  valueOptions: ['-c', '--cmd', '-u', '-U', '-t', '-T', '-w', '-W'],
  skipPlusWords: true,
};

const TR_SPEC: ToolSpec = {
  noPositionalPaths: true,
};

const TOOL_SPECS: Record<string, ToolSpec> = {
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  rgrep: GREP_SPEC,
  bzgrep: GREP_SPEC,
  zgrep: GREP_SPEC,
  zegrep: GREP_SPEC,
  zfgrep: GREP_SPEC,
  xzgrep: GREP_SPEC,
  lzgrep: GREP_SPEC,
  rg: RG_SPEC,
  awk: AWK_SPEC,
  gawk: AWK_SPEC,
  mawk: AWK_SPEC,
  nawk: AWK_SPEC,
  sed: SED_SPEC,
  gsed: SED_SPEC,
  jq: JQ_SPEC,
  perl: PERL_SPEC,
  ruby: PERL_SPEC,
  less: LESS_SPEC,
  more: LESS_SPEC,
  vim: VIM_SPEC,
  vi: VIM_SPEC,
  view: VIM_SPEC,
  gvim: VIM_SPEC,
  nvim: VIM_SPEC,
  ex: VIM_SPEC,
  tr: TR_SPEC,
};

/** find's global options that may precede the search paths. */
const FIND_GLOBAL_FLAGS = new Set([
  '-L',
  '-H',
  '-P',
  '-D',
  '-O',
  '-maxdepth',
  '-mindepth',
  '-depth',
  '-xdev',
  '-mount',
  '-noleaf',
]);
/** Subset of the global flags that consume the following word as a value. */
const FIND_GLOBAL_VALUE_OPTIONS = new Set(['-D', '-O', '-maxdepth', '-mindepth']);

/**
 * A word that is exactly one variable reference (`$VAR`, `${VAR}`, `$1`,
 * `$@`, …) with nothing else attached. Compound words such as `$0~pat` or
 * `$1 ~ /re[0-9]/` (awk programs) are not variable references.
 */
const PURE_VARIABLE = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!])(\[[^\]]*\])?$/;

/**
 * Extract the leading search paths from a `find` invocation.
 *
 * Everything before the first predicate/option word is a path; expressions
 * (`-name`, `-regex`, `-exec`, …) are never paths.
 */
function extractFindPaths(args: string[]): string[] {
  const paths: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (!FIND_GLOBAL_FLAGS.has(arg)) break; // first predicate — nothing further is a path
      i += FIND_GLOBAL_VALUE_OPTIONS.has(arg) ? 2 : 1;
      continue;
    }
    if (PURE_VARIABLE.test(arg)) {
      i++;
      continue;
    }
    paths.push(arg);
    i++;
  }
  return paths;
}

/**
 * Derive a tool name from a command word, or `undefined` when the word is not
 * a plain command name (variables, assignments, expansions).
 */
function toolName(commandWord: string | undefined): string | undefined {
  if (!commandWord) return undefined;
  const bare = commandWord.replace(/['"]/g, '');
  if (!bare || /[$= \t\n]/.test(bare)) return undefined;
  return bare.split('/').pop()!.toLowerCase();
}

/**
 * Filter a tool's argument words down to those that may be file-system paths.
 *
 * Words are raw AST word texts or tokenizer tokens (quotes already stripped by
 * the caller where applicable). Unknown tools fall back to generic behavior:
 * drop options and variable references, keep everything else.
 *
 * Known tools additionally drop *pure* variable references (`$VAR`, `$1`, …)
 * while keeping compound words (`$0~pat`) that form part of a pattern/script.
 *
 * @param commandWord - The command's name word (e.g. `grep`, `/usr/bin/awk`).
 * @param args - Argument words in order.
 * @param skipAllDollarWords - Legacy fallback policy for unknown tools: when
 *   true, drop every word starting with `$`; when false, keep them. Callers
 *   extracting from an AST pass true; string-tokenizer callers pass false.
 * @returns The argument words that should be treated as potential paths.
 */
export function filterPathArguments(
  commandWord: string | undefined,
  args: string[],
  skipAllDollarWords = false,
): string[] {
  const tool = toolName(commandWord);

  if (tool === 'find') return extractFindPaths(args);

  const spec = tool ? TOOL_SPECS[tool] : undefined;
  if (!spec) {
    return args.filter((a) => !a.startsWith('-') && !(skipAllDollarWords && a.startsWith('$')));
  }

  const paths: string[] = [];
  let patternSlots = spec.firstPositionalIsPattern ? 1 : 0;
  let optionsEnded = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i]!;

    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      i++;
      continue;
    }

    if (!optionsEnded && arg.startsWith('-')) {
      const letters = arg.slice(1);
      if (
        spec.codeFlagLetters &&
        /^[A-Za-z]+$/.test(letters) &&
        [...letters].some((c) => spec.codeFlagLetters!.includes(c))
      ) {
        i += 2; // combined code flags (-pe, -wle) consume the program as the next word
        continue;
      }
      if (spec.patternOptions?.includes(arg)) {
        patternSlots = 0; // pattern supplied via option; remaining positionals are paths
        i += 2;
        continue;
      }
      if (spec.valueOptions?.includes(arg)) {
        i += 2;
        continue;
      }
      i++; // plain flag
      continue;
    }

    if (PURE_VARIABLE.test(arg)) {
      i++;
      continue;
    }
    if (spec.skipPlusWords && arg.startsWith('+')) {
      i++;
      continue;
    }
    if (spec.noPositionalPaths) {
      i++;
      continue;
    }
    if (patternSlots > 0) {
      patternSlots--;
      i++;
      continue;
    }
    paths.push(arg);
    i++;
  }

  return paths;
}
