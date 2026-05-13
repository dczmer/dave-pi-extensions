import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

/** Structured log entry for a failed or blocked tool execution. */
export interface LogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Session file path, if available. */
  session?: string | undefined;
  /** Tool name. */
  tool: string;
  /** Unique tool call ID. */
  callId: string;
  /** Tool arguments stashed from tool_execution_start. */
  input: unknown;
  /** Failure category. */
  category: 'blocked' | 'execution' | 'timeout' | 'aborted';
  /** Source extension name or 'execution'. */
  source: string;
  /** Block reason or capped error content. */
  reason?: string;
}

/** Maximum length for reason text before truncation. */
export const REASON_CAP = 4096;

/** Truncation marker appended when reason is capped. */
export const TRUNCATED_MARKER = '[...truncated...]';

/**
 * Return default log file path.
 *
 * @returns Absolute path to `~/.pi/agent/harness-errors.jsonl`.
 */
export function getDefaultLogPath(): string {
  return `${homedir()}/.pi/agent/harness-errors.jsonl`;
}

/**
 * Cap text to a maximum length, appending a truncation marker when shortened.
 *
 * @param text - Raw text to cap.
 * @param maxLen - Maximum allowed length (excluding marker). Defaults to REASON_CAP.
 * @returns Capped text with marker when truncated.
 */
export function capText(text: string, maxLen = REASON_CAP): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + TRUNCATED_MARKER;
}

/**
 * Detect failure category from an error or reason string.
 *
 * @param reason - Optional error content or block reason.
 * @returns Detected category heuristic.
 */
export function detectCategory(reason?: string): LogEntry['category'] {
  if (!reason) return 'execution';
  if (reason.includes('timed out after')) return 'timeout';
  if (reason.includes('Command aborted')) return 'aborted';
  return 'execution';
}

/**
 * Build a log entry.
 *
 * @param ts - ISO-8601 timestamp string.
 * @param session - Session file path or undefined.
 * @param tool - Tool name.
 * @param callId - Tool call ID.
 * @param input - Tool arguments.
 * @param category - Failure category.
 * @param source - Source extension or 'execution'.
 * @param reason - Optional reason or error text.
 * @returns LogEntry object.
 */
export function buildEntry(
  ts: string,
  session: string | undefined,
  tool: string,
  callId: string,
  input: unknown,
  category: LogEntry['category'],
  source: string,
  reason?: string,
): LogEntry {
  const entry: LogEntry = {
    ts,
    session,
    tool,
    callId,
    input,
    category,
    source,
  };
  if (reason !== undefined) {
    entry.reason = capText(reason);
  }
  return entry;
}

/**
 * Append a log entry as JSONL to the given path.
 *
 * Creates parent directories on first write. Swallows write errors.
 *
 * @param logPath - Path to the JSONL file.
 * @param entry - Entry to append.
 * @returns Whether write succeeded.
 */
export function writeEntry(logPath: string, entry: LogEntry): boolean {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all log entries from a JSONL file.
 *
 * Skips malformed lines.
 *
 * @param logPath - Path to the JSONL file.
 * @returns Array of parsed LogEntry objects.
 */
export function readEntries(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

/**
 * Count total log entries in a JSONL file.
 *
 * @param logPath - Path to the JSONL file.
 * @returns Number of valid entries.
 */
export function countEntries(logPath: string): number {
  return readEntries(logPath).length;
}
