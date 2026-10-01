/**
 * Session file parsing and display-block construction for the session viewer.
 *
 * A session file is a JSONL transcript: the first line is a session header,
 * followed by id/parentId-linked entries (messages, model changes, compaction,
 * ...). parseSession() reuses pi's own parser (raw entries, no migration) and
 * toDisplayBlocks() flattens entries into the DisplayBlocks that the
 * transcript renderer turns into styled lines.
 */

import { readFileSync } from 'node:fs';

import { parseSessionEntries } from '@earendil-works/pi-coding-agent';
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from '@earendil-works/pi-ai';

/** Parsed content of one tool result message, keyed by toolCallId. */
export interface ParsedToolResult {
  /** Name of the tool that produced this result. */
  toolName: string;
  /** Concatenated text content of the result. */
  text: string;
  /** True when the tool execution reported an error. */
  isError: boolean;
}

/** Parsed session file: header, raw entries, and tool results indexed by toolCallId. */
export interface ParsedSession {
  /** First line of the file: session metadata. */
  header: SessionHeader;
  /** All entries (no header), in file order, without migration. */
  entries: SessionEntry[];
  /** Tool results keyed by toolCallId. */
  toolResults: Map<string, ParsedToolResult>;
}

/** One displayable unit of a transcript, in file order. */
export type DisplayBlock =
  | { kind: 'user'; text: string }
  | {
      /**
       * One assistant message. Rendering walks its content blocks in order
       * (thinking, text, tool calls) and pairs tool calls with results.
       */
      kind: 'assistant';
      message: AssistantMessage;
    }
  | {
      /**
       * A tool result whose assistant tool call was not rendered (orphan,
       * e.g. in branched sessions); rendered on its own.
       */
      kind: 'orphan_result';
      result: ParsedToolResult;
    }
  | {
      /**
       * Structural note. detail=false blocks (compaction, displayable custom
       * messages) always render; detail=true blocks (model/thinking changes,
       * branch summaries, labels) can be hidden with the `z` toggle.
       */
      kind: 'meta';
      text: string;
      detail: boolean;
    };

/**
 * Extract plain text from a message content array, marking non-text blocks.
 * @param content - Text/image content blocks.
 * @returns Concatenated text; image blocks become `[image]`.
 */
export function contentText(content: (TextContent | ImageContent)[]): string {
  return content
    .map((block) =>
      block.type === 'text' ? block.text
      : block.type === 'image' ? '[image]'
      : '',
    )
    .join('');
}

/**
 * Parse a session file and index its tool results.
 *
 * Malformed lines are skipped by pi's own parser; a file whose first entry is
 * not a session header is rejected.
 *
 * @param path - Path to a `*.jsonl` session file.
 * @returns Parsed session structure, or null when the file is unreadable or has no header.
 */
export function parseSession(path: string): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const fileEntries = parseSessionEntries(raw);
  const header = fileEntries[0];
  if (!header || header.type !== 'session') {
    return null;
  }
  const entries = fileEntries.slice(1).filter((e): e is SessionEntry => e.type !== 'session');
  const toolResults = new Map<string, ParsedToolResult>();
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      const result = entry.message as ToolResultMessage;
      toolResults.set(result.toolCallId, {
        toolName: result.toolName,
        text: contentText(result.content),
        isError: result.isError,
      });
    }
  }
  return { header, entries, toolResults };
}

/**
 * Walk an entry list and emit display blocks for the transcript view.
 *
 * Tool result messages are consumed by their assistant message (the assistant
 * entry is always an ancestor, hence earlier in file order); a tool result
 * whose call was never seen renders as its own orphan block. System-role
 * messages are skipped.
 *
 * @param entries - Parsed session entries (no header).
 * @returns Display blocks in file order.
 */
export function toDisplayBlocks(entries: SessionEntry[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  const consumed = new Set<string>();
  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        const message = entry.message;
        if (message.role === 'user') {
          blocks.push({
            kind: 'user',
            text: typeof message.content === 'string' ? message.content : contentText(message.content),
          });
        } else if (message.role === 'assistant') {
          for (const block of message.content) {
            if (block.type === 'toolCall') {
              consumed.add(block.id);
            }
          }
          blocks.push({ kind: 'assistant', message });
        } else if (message.role === 'toolResult') {
          if (!consumed.has(message.toolCallId)) {
            blocks.push({
              kind: 'orphan_result',
              result: { toolName: message.toolName, text: contentText(message.content), isError: message.isError },
            });
          }
        }
        break;
      }
      case 'model_change':
        blocks.push({ kind: 'meta', detail: true, text: `◆ Model: ${entry.provider}/${entry.modelId}` });
        break;
      case 'thinking_level_change':
        blocks.push({ kind: 'meta', detail: true, text: `◆ Thinking: ${entry.thinkingLevel}` });
        break;
      case 'label':
        if (entry.label !== undefined) {
          blocks.push({ kind: 'meta', detail: true, text: `◆ Label: ${entry.label}` });
        }
        break;
      case 'compaction':
        blocks.push({
          kind: 'meta',
          detail: false,
          text: `◆ Compaction (${entry.tokensBefore} tokens before): ${entry.summary}`,
        });
        break;
      case 'branch_summary':
        blocks.push({ kind: 'meta', detail: true, text: `◆ Branch: ${entry.summary}` });
        break;
      case 'custom_message':
        if (entry.display !== false) {
          blocks.push({
            kind: 'meta',
            detail: false,
            text: typeof entry.content === 'string' ? entry.content : contentText(entry.content),
          });
        }
        break;
      default:
        break;
    }
  }
  return blocks;
}
