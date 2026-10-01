/**
 * Pure transcript rendering for the session viewer.
 *
 * Turns a parsed session into a flat array of ANSI-styled terminal lines at
 * a given width, using only pi's Theme for coloring (no hard-coded escapes).
 * Rendering is memoized per (path, width, meta-visibility) so session
 * switches, resizes, and the meta toggle stay cheap.
 */

import { buildContextEntries, type SessionEntry, type Theme } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import {
  parseSession,
  toDisplayBlocks,
  type DisplayBlock,
  type ParsedSession,
  type ParsedToolResult,
} from './format.ts';

/** Maximum number of tool output lines rendered before elision. */
export const MAX_TOOL_OUTPUT_LINES = 200;

/** Aggregated token usage and cost across assistant messages. */
export interface UsageTotals {
  /** Total input tokens. */
  input: number;
  /** Total output tokens. */
  output: number;
  /** Total cache-read tokens. */
  cacheRead: number;
  /** Total cache-write tokens. */
  cacheWrite: number;
  /** Total tokens, as reported by the provider. */
  totalTokens: number;
  /** Total USD cost. */
  totalCost: number;
}

/**
 * Sum token usage and cost across the assistant messages in an entry list.
 * @param entries - Parsed session entries.
 * @returns Aggregated totals (zeroed when there are no assistant messages).
 */
export function aggregateUsage(entries: SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const usage = entry.message.usage;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.totalTokens += usage.totalTokens;
    totals.totalCost += usage.cost.total;
  }
  return totals;
}

/**
 * Render a parsed session as flat styled lines.
 *
 * Entries are reduced to the active branch via pi's buildContextEntries
 * (compaction elision included), flattened into display blocks, then laid
 * out: a header line, one blank line between blocks, and a usage footer.
 *
 * @param session - Parsed session file.
 * @param theme - Theme used for all coloring.
 * @param width - Available terminal columns (already excludes pane padding).
 * @param showMeta - When false, detail meta entries are hidden.
 * @param name - Optional session name (from session_info); falls back to the session id.
 * @returns Styled transcript lines.
 */
export function renderTranscript(
  session: ParsedSession,
  theme: Theme,
  width: number,
  showMeta: boolean,
  name?: string,
): string[] {
  const active = buildContextEntries(session.entries);
  const blocks = toDisplayBlocks(active);

  const lines: string[] = [theme.fg('dim', truncateToWidth(headerText(session, name), width)), ''];
  for (const block of blocks) {
    const blockLines = renderBlock(block, session.toolResults, theme, width, showMeta);
    if (blockLines.length === 0) continue;
    lines.push(...blockLines, '');
  }
  lines.push(theme.fg('dim', formatUsageLine(aggregateUsage(active))));
  return lines;
}

/** Memoized rendered transcripts keyed by path, width, and meta-visibility. */
const cache = new Map<string, string[]>();

/**
 * Render a session file from disk, memoized by path, width, and meta-visibility.
 *
 * A file that fails to parse renders as a single error line (also cached).
 *
 * @param path - Path to the session file.
 * @param width - Available terminal columns.
 * @param showMeta - When false, detail meta entries are hidden.
 * @param theme - Theme used for all coloring.
 * @param name - Optional session name (from session_info).
 * @returns Styled transcript lines.
 */
export function getRenderedTranscript(
  path: string,
  width: number,
  showMeta: boolean,
  theme: Theme,
  name?: string,
): string[] {
  const key = `${path}|${width}|${showMeta ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const session = parseSession(path);
  const lines =
    session ?
      renderTranscript(session, theme, width, showMeta, name)
    : [theme.fg('error', `Could not read session: ${path}`)];
  cache.set(key, lines);
  return lines;
}

/**
 * Clear the transcript render cache (e.g. when the theme is reloaded).
 */
export function clearTranscriptCache(): void {
  cache.clear();
}

/** Build the header line text for a parsed session. */
function headerText(session: ParsedSession, name?: string): string {
  const title = name ?? session.header.id.slice(0, 8);
  const cwd = session.header.cwd || '(no cwd)';
  return `${title}  ${cwd}  ${formatTimestamp(session.header.timestamp)}`;
}

/** Render one display block to styled lines (empty when the block is hidden). */
function renderBlock(
  block: DisplayBlock,
  toolResults: Map<string, ParsedToolResult>,
  theme: Theme,
  width: number,
  showMeta: boolean,
): string[] {
  switch (block.kind) {
    case 'user':
      return renderUserBlock(block.text, theme, width);
    case 'assistant':
      return renderAssistantBlock(block.message, toolResults, theme, width);
    case 'orphan_result':
      return renderOrphanResultBlock(block.result, theme, width);
    case 'meta': {
      if (block.detail && !showMeta) return [];
      return renderMetaBlock(block.text, block.detail, theme, width);
    }
  }
}

/** Render a user message: accent label line, then a full-width message block. */
function renderUserBlock(text: string, theme: Theme, width: number): string[] {
  const lines: string[] = [theme.bold(theme.fg('accent', '▸ you'))];
  for (const line of wrapTextWithAnsi(text, width)) {
    lines.push(theme.bg('userMessageBg', theme.fg('userMessageText', padTo(line, width))));
  }
  return lines;
}

/**
 * Render an assistant message: accent model header, then its content blocks
 * in order (thinking collapsed to one line, text plain, tool calls paired
 * with their results).
 */
function renderAssistantBlock(
  message: AssistantMessage,
  toolResults: Map<string, ParsedToolResult>,
  theme: Theme,
  width: number,
): string[] {
  const lines: string[] = [theme.bold(theme.fg('accent', `◂ ${message.model}`))];
  for (const block of message.content) {
    if (block.type === 'thinking') {
      const preview = block.thinking.split('\n', 1)[0] ?? '';
      lines.push(theme.italic(theme.fg('dim', truncateToWidth(`thinking: ${preview}`, width))));
    } else if (block.type === 'text') {
      for (const line of wrapTextWithAnsi(block.text, width)) {
        lines.push(theme.fg('text', line));
      }
    } else if (block.type === 'toolCall') {
      lines.push(...renderToolCallBlock(block, toolResults.get(block.id), theme, width));
    }
  }
  return lines;
}

/** Render a tool call line (name plus one-line arguments) followed by its result. */
function renderToolCallBlock(
  call: ToolCall,
  result: ParsedToolResult | undefined,
  theme: Theme,
  width: number,
): string[] {
  const title = theme.fg('toolTitle', `⚙ ${call.name}`);
  const args = safeStringify(call.arguments);
  const lines: string[] = [];
  const remaining = width - visibleWidth(title) - 1;
  if (args.length > 0 && remaining >= 4) {
    lines.push(title + theme.fg('muted', ` ${truncateToWidth(args, remaining)}`));
  } else {
    lines.push(title);
  }
  if (result) {
    lines.push(...renderToolResultLines(result, theme, width));
  } else {
    lines.push(theme.italic(theme.fg('muted', '  (no result)')));
  }
  return lines;
}

/** Render an orphan tool result (no assistant tool call to attach to). */
function renderOrphanResultBlock(result: ParsedToolResult, theme: Theme, width: number): string[] {
  const lines: string[] = [theme.fg('toolTitle', `⚙ ${result.toolName}`)];
  lines.push(...renderToolResultLines(result, theme, width));
  return lines;
}

/**
 * Render tool output lines: two-space indented, error vs. tool output
 * colored, elided after MAX_TOOL_OUTPUT_LINES with a "more lines" marker.
 */
function renderToolResultLines(result: ParsedToolResult, theme: Theme, width: number): string[] {
  const wrapped = wrapTextWithAnsi(result.text, Math.max(1, width - 2));
  const color = (line: string) => theme.fg(result.isError ? 'error' : 'toolOutput', `  ${line}`);
  const lines = wrapped.slice(0, MAX_TOOL_OUTPUT_LINES).map(color);
  const extra = wrapped.length - MAX_TOOL_OUTPUT_LINES;
  if (extra > 0) {
    lines.push(theme.italic(theme.fg('muted', `  … ${fmtInt(extra)} more lines`)));
  }
  return lines;
}

/** Render a structural note (compaction, branch, meta) as one or more lines. */
function renderMetaBlock(text: string, detail: boolean, theme: Theme, width: number): string[] {
  const style = (line: string) => (detail ? theme.italic(theme.fg('dim', line)) : theme.fg('muted', line));
  return wrapTextWithAnsi(text, width).map(style);
}

/** Pad a line with spaces up to exactly `width` visible columns. */
function padTo(line: string, width: number): string {
  const remaining = width - visibleWidth(line);
  return remaining > 0 ? line + ' '.repeat(remaining) : line;
}

/** Stringify tool arguments for a one-line preview, tolerating cycles. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Format an integer with thousands separators. */
function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Format the aggregated usage footer line. */
function formatUsageLine(totals: UsageTotals): string {
  return `tokens: ${fmtInt(totals.input)} in · ${fmtInt(totals.output)} out · ${fmtInt(totals.cacheRead)} cache · ${fmtInt(
    totals.totalTokens,
  )} total · $${totals.totalCost.toFixed(4)}`;
}

/** Format an ISO timestamp as 'YYYY-MM-DD HH:MM'. */
function formatTimestamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}
