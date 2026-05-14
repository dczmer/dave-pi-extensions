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
  /** Bash exit code, when available. */
  exitCode?: number;
  /** Captured bash output preview, when available. */
  outputPreview?: string;
}

/** Maximum length for reason text before truncation. */
export const REASON_CAP = 4096;

/** Truncation marker appended when reason is capped. */
export const TRUNCATED_MARKER = '[...truncated...]';

/** Lines to keep from bash output for preview. */
export const OUTPUT_PREVIEW_LINES = 10;

/** Maximum length for bash output preview before truncation. */
export const OUTPUT_PREVIEW_CAP = 1024;

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
 * Extract bash exit code and output preview from a bash error string.
 *
 * @param result - Tool result value.
 * @param toolName - Tool name.
 * @returns Object with optional exitCode and outputPreview.
 */
export function extractBashInfo(result: unknown, toolName: string): { exitCode?: number; outputPreview?: string } {
  if (toolName !== 'bash' || typeof result !== 'string') return {};

  const exitMatch = result.match(/Command exited with code (\d+)/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;

  const separators = ['\n\nCommand exited with code', '\n\nCommand timed out after', '\n\nCommand aborted'];
  let outputPart: string | undefined;
  for (const sep of separators) {
    if (result.includes(sep)) {
      outputPart = result.split(sep)[0];
      break;
    }
  }

  if (outputPart === undefined) {
    return exitCode !== undefined ? { exitCode } : {};
  }

  const preview = outputPart.split('\n').slice(0, OUTPUT_PREVIEW_LINES).join('\n');
  const info: { exitCode?: number; outputPreview?: string } = { outputPreview: capText(preview, OUTPUT_PREVIEW_CAP) };
  if (exitCode !== undefined) {
    info.exitCode = exitCode;
  }
  return info;
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
 * @param exitCode - Optional bash exit code.
 * @param outputPreview - Optional bash output preview.
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
  exitCode?: number,
  outputPreview?: string,
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
  if (exitCode !== undefined) {
    entry.exitCode = exitCode;
  }
  if (outputPreview !== undefined) {
    entry.outputPreview = outputPreview;
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
