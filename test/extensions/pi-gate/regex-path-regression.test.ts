// Regression tests: regex-pattern arguments are incorrectly extracted as
// file paths by pi-gate's path extraction, which makes the external-directory
// guard prompt for (or block) commands whose only "paths" are regexes such as
// `grep '/pat/'`, `sed '/pat/,+15p'`, or `awk '/pat/{ cmd }'`.
//
// These tests assert the desired behavior and currently FAIL. They were
// collected by probing the extractors with regex-bearing commands; each case
// below was verified to be flagged as a path by either
// `extractPathsFromAST` (src/bash-parser.ts) or `extractPathsFromCommand`
// (extensions/pi-gate/guards.ts).
//
// Known ambiguous cases deliberately excluded from the assertions:
// - `grep '/tmp/' file` — path-shaped regex; indistinguishable from a real
//   directory path without an existence check.
// - `grep --include='*.ts' -r foo src/` — bare-word pattern `foo` looks like
//   a relative path and normalizes inside the project tree.

import { strictEqual, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { parseBashCommand, extractPathsFromAST, walkCommands } from '../../../src/bash-parser.ts';
import { extractPathsFromCommand } from '../../../extensions/pi-gate/guards.ts';
import { checkBashCommand } from '../../../extensions/pi-gate/bash-guard.ts';
import { resetSessionState } from '../../../extensions/pi-gate/session.ts';
import { createQueuedUIContext } from '../../utils/pi-context.ts';
import { createConfigResult } from './utils/config.ts';

/** Extract paths the way checkSingleCommand does when an AST node is available. */
function extractPathsViaAST(command: string): string[] {
  const ast = parseBashCommand(command);
  const paths: string[] = [];
  walkCommands(ast, (cmd) => paths.push(...extractPathsFromAST(cmd)));
  return paths;
}

// ---------------------------------------------------------------------------
// grep / egrep / rg — pattern args in every quoting style
// ---------------------------------------------------------------------------

const grepCases: Array<{ command: string; expected: string[] }> = [
  { command: "grep '/pat/' file.txt", expected: ['file.txt'] },
  { command: 'grep /pat/ file.txt', expected: ['file.txt'] },
  { command: "grep '/pat/sub/' file.txt", expected: ['file.txt'] },
  { command: 'grep /pat/sub/ file.txt', expected: ['file.txt'] },
  { command: 'grep -e /pat/ file.txt', expected: ['file.txt'] },
  { command: 'grep -E "^/foo/bar" file.txt', expected: ['file.txt'] },
  { command: "grep -r 'error|warning' /var/log", expected: ['/var/log'] },
  { command: 'egrep /re[0-9]+/ file.txt', expected: ['file.txt'] },
  { command: 'rg "/pat/" src/', expected: ['src/'] },
];

for (const { command, expected } of grepCases) {
  test(`REGRESSION grep: regex arg not a path: ${command}`, () => {
    deepStrictEqual(extractPathsViaAST(command), expected);
  });
}

// ---------------------------------------------------------------------------
// sed — addresses, ranges, substitutions, transliterations
// ---------------------------------------------------------------------------

const sedCases: Array<{ command: string; expected: string[] }> = [
  { command: "sed '/pat/d' file.txt", expected: ['file.txt'] },
  { command: "sed -n '/pat/,+15p' file.txt", expected: ['file.txt'] },
  { command: "sed -n '/start/,/end/p' file.txt", expected: ['file.txt'] },
  { command: "sed '/pat/,/sub/d' file.txt", expected: ['file.txt'] },
  { command: "sed '/^$/d' file.txt", expected: ['file.txt'] },
  { command: "sed -n '1~3p' file.txt", expected: ['file.txt'] },
  { command: "sed 's/foo/bar/' file.txt", expected: ['file.txt'] },
  { command: "sed 's|/usr/local|/opt|g' file.txt", expected: ['file.txt'] },
  { command: "sed 'y/abc/def/' file.txt", expected: ['file.txt'] },
];

for (const { command, expected } of sedCases) {
  test(`REGRESSION sed: regex/script arg not a path: ${command}`, () => {
    deepStrictEqual(extractPathsViaAST(command), expected);
  });
}

// ---------------------------------------------------------------------------
// awk / gawk — program text args
// ---------------------------------------------------------------------------

const awkCases: Array<{ command: string; expected: string[] }> = [
  { command: "awk '/pat/{ print $1 }' file.txt", expected: ['file.txt'] },
  { command: "gawk '/pat/{ cmd }' file.txt", expected: ['file.txt'] },
  { command: "awk -F/ '/pat/ {print $0}' file.txt", expected: ['file.txt'] },
  { command: "awk 'NR==1,/end/' file.txt", expected: ['file.txt'] },
  { command: 'awk \'BEGIN{RS=","}\' file.txt', expected: ['file.txt'] },
  { command: "awk '$1 ~ /re[0-9]/' file.txt", expected: ['file.txt'] },
  { command: "awk -v pat='/re/' '$0~pat' file.txt", expected: ['file.txt'] },
];

for (const { command, expected } of awkCases) {
  test(`REGRESSION awk: program arg not a path: ${command}`, () => {
    deepStrictEqual(extractPathsViaAST(command), expected);
  });
}

// ---------------------------------------------------------------------------
// Other tools whose arguments are patterns/scripts, not paths
// ---------------------------------------------------------------------------

const otherToolCases: Array<{ command: string; expected: string[] }> = [
  { command: "perl -pe 's/a/b/' file.txt", expected: ['file.txt'] },
  { command: "perl -ne 'print if /pat/' file.txt", expected: ['file.txt'] },
  { command: "less '+/pat' file.txt", expected: ['file.txt'] },
  { command: "vim '+/pat' file.txt", expected: ['file.txt'] },
  { command: "ex -s -c '/pat/d' file.txt", expected: ['file.txt'] },
  { command: "find . -regex '.*/[0-9]+\\.txt'", expected: ['.'] },
  { command: "tr '/' '-' < file.txt", expected: [] },
  { command: 'jq \'.a[] | select(.b | test("/pat/"))\' data.json', expected: ['data.json'] },
];

for (const { command, expected } of otherToolCases) {
  test(`REGRESSION misc: pattern/script arg not a path: ${command}`, () => {
    deepStrictEqual(extractPathsViaAST(command), expected);
  });
}

// ---------------------------------------------------------------------------
// String tokenizer fallback (extractPathsFromCommand) — unquoted regexes
// ---------------------------------------------------------------------------

const stringTokenizerCases: Array<{ command: string; expected: string[] }> = [
  { command: 'grep /pat/ file.txt', expected: ['file.txt'] },
  { command: 'grep /pat/sub/ file.txt', expected: ['file.txt'] },
  { command: 'grep -e /pat/ file.txt', expected: ['file.txt'] },
  { command: 'egrep /re[0-9]+/ file.txt', expected: ['file.txt'] },
];

for (const { command, expected } of stringTokenizerCases) {
  test(`REGRESSION tokenizer: unquoted regex arg not a path: ${command}`, () => {
    deepStrictEqual(extractPathsFromCommand(command), expected);
  });
}

// ---------------------------------------------------------------------------
// End-to-end: regex-bearing commands must not trigger the external-path guard
// ---------------------------------------------------------------------------

/** Bash-allow config covering a single tool; empty queues prove no prompt fires. */
function regexCommandConfig(toolPattern: string) {
  return createConfigResult({
    merged: { bashAllow: [toolPattern], externalAllow: [] },
    project: { bashAllow: [toolPattern], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
}

const e2eCases: Array<{ command: string; toolPattern: string }> = [
  { command: "grep '/pat/' file.txt", toolPattern: 'grep *' },
  { command: 'grep /pat/sub/ file.txt', toolPattern: 'grep *' },
  { command: "sed '/pat/d' file.txt", toolPattern: 'sed *' },
  { command: "sed -n '/pat/,+15p' file.txt", toolPattern: 'sed *' },
  { command: "awk '/pat/{ print $1 }' file.txt", toolPattern: 'awk *' },
  { command: "sed 's|/usr/local|/opt|g' file.txt", toolPattern: 'sed *' },
  { command: "less '+/pat' file.txt", toolPattern: 'less *' },
];

for (const { command, toolPattern } of e2eCases) {
  test(`REGRESSION e2e: no external-path prompt for regex arg: ${command}`, async () => {
    resetSessionState();
    try {
      const ctx = createQueuedUIContext();
      // Empty queues: any prompt would resolve to denial, so `true` proves
      // the external-path guard stayed silent.
      const result = await checkBashCommand(command, '/proj', regexCommandConfig(toolPattern), ctx);
      strictEqual(result, true);
      strictEqual(ctx._notifications.length, 0);
    } finally {
      resetSessionState();
    }
  });
}

// ---------------------------------------------------------------------------
// Constraints for the eventual fix: genuine external paths in the same
// commands must still be checked (these pass today).
// ---------------------------------------------------------------------------

test('constraint: external path arg of grep is still blocked', async () => {
  resetSessionState();
  try {
    const ctx = createQueuedUIContext();
    ctx.queueEditor(null); // reject the external-path pattern prompt
    const result = await checkBashCommand("grep '/pat/' /etc/passwd", '/proj', regexCommandConfig('grep *'), ctx);
    strictEqual(result, false);
  } finally {
    resetSessionState();
  }
});

test('constraint: external path arg of sed is still blocked', async () => {
  resetSessionState();
  try {
    const ctx = createQueuedUIContext();
    ctx.queueEditor(null); // reject the external-path pattern prompt
    const result = await checkBashCommand("sed '/pat/d' /etc/passwd", '/proj', regexCommandConfig('sed *'), ctx);
    strictEqual(result, false);
  } finally {
    resetSessionState();
  }
});
