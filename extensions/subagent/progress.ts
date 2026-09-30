/**
 * Live per-subagent progress extraction from the child's session event stream.
 *
 * Wire `message_update` records are delta-only, so text blocks are
 * reconstructed per `contentIndex` and the last non-empty line of the active
 * block becomes the status line. Tool execution events map to a short
 * synthesized line instead.
 */
import { truncateToWidth } from '@earendil-works/pi-tui';

/** Maximum width of a subagent status line, in display columns. */
export const STATUS_MAX_WIDTH = 80;

/** Mutable per-child progress extraction state. */
export interface ProgressState {
  /** Reconstructed text block content, keyed by `contentIndex`. */
  textBlocks: Map<number, string>;
  /** Most recent status line emitted. */
  lastLine: string;
}

/** Create empty progress extraction state for one child run. */
export function createProgressState(): ProgressState {
  return { textBlocks: new Map(), lastLine: '' };
}

function setLine(state: ProgressState, line: string): string {
  state.lastLine = line;
  return line;
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return undefined;
}

/**
 * Extract a display status line from one session event record.
 *
 * Returns `undefined` for events that carry no displayable progress
 * (including `thinking_delta` blocks, which are deliberately ignored).
 */
export function statusLineFromEvent(event: unknown, state: ProgressState): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const rec = event as Record<string, unknown>;

  if (rec.type === 'tool_execution_start') {
    const toolName = typeof rec.toolName === 'string' ? rec.toolName : 'tool';
    const args = rec.args === undefined ? '' : JSON.stringify(rec.args);
    const preview = args.length > 60 ? `${args.slice(0, 60)}...` : args;
    return setLine(state, preview ? `→ ${toolName} ${preview}` : `→ ${toolName}`);
  }

  if (rec.type === 'tool_execution_update') {
    const partial = rec.partialResult as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (!partial?.content) return undefined;
    for (let i = partial.content.length - 1; i >= 0; i--) {
      const part = partial.content[i];
      if (part?.type === 'text' && typeof part.text === 'string') {
        const line = lastNonEmptyLine(part.text);
        if (line) return setLine(state, line);
      }
    }
    return undefined;
  }

  if (rec.type === 'message_update') {
    const ev = rec.assistantMessageEvent as
      | { type?: string; contentIndex?: number; delta?: string; content?: string }
      | undefined;
    if (!ev || typeof ev.type !== 'string') return undefined;
    const contentIndex = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0;

    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      const buffer = (state.textBlocks.get(contentIndex) ?? '') + ev.delta;
      state.textBlocks.set(contentIndex, buffer);
      const line = lastNonEmptyLine(buffer);
      if (line) return setLine(state, line);
    } else if (ev.type === 'text_end' && typeof ev.content === 'string') {
      state.textBlocks.set(contentIndex, ev.content);
      const line = lastNonEmptyLine(ev.content);
      if (line) return setLine(state, line);
    }
    return undefined;
  }

  return undefined;
}

/** Truncate to STATUS_MAX_WIDTH display columns (pi-tui truncateToWidth). */
export function truncateStatus(line: string): string {
  return truncateToWidth(line, STATUS_MAX_WIDTH);
}
